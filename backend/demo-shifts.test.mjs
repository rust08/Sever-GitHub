import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {demoShiftResponse} from './demo-shifts.mjs';
import {createCatalog} from './service.mjs';
import {validateUnifiedPlan} from './unified-shift.mjs';

test('snowfall revisions retain started trips, costs, original report and history across reopen',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'snow-revisions-'));
  function open(){
    const db=new DatabaseSync(join(dir,'demo.sqlite'));
    db.exec(readFileSync(new URL('../drizzle/0005_demo_shift_revisions.sql',import.meta.url),'utf8'));
    return db;
  }
  let db=open();
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const data=createCatalog({scope:'city',version:'test',depot:'a',nodes:{a:[0,0],b:[1,0]},
    edges:[{id:'ab',from:'a',to:'b',highway:'primary',km:1,oneway:false}]});
  const call=(path='',body)=>demoShiftResponse(new Request('http://localhost/api/demo-shifts'+path,
    body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),db,data);
  const {id}=await (await call('',{scenario:'normal'})).json();
  const before=await (await call('/'+id)).json();
  const second=await (await call('',{scenario:'normal'})).json();
  assert.deepEqual((await (await call('/'+second.id)).json()).plan,before.plan);
  const heavy=await (await call('',{scenario:'heavy'})).json();
  assert.equal((await (await call('/'+heavy.id)).json()).input.options.volume,40);
  const event={expectedRevision:1,minute:2,addedM3:15};
  const path='/'+id+'/snowfall';
  assert.equal((await call(path,event)).status,201);
  assert.equal((await call(path,event)).status,200);
  assert.equal((await call(path,{...event,addedM3:11})).status,409);
  assert.equal((await call(path,{...event,expectedRevision:2,minute:1})).status,422);
  const revised=await (await call('/'+id)).json();
  validateUnifiedPlan(revised.plan);
  assert.deepEqual(revised.plan.clearing,before.plan.clearing);
  assert.deepEqual(revised.plan.haul.trips[0],before.plan.haul.trips[0]);
  assert.equal(revised.plan.haul.delivered+revised.plan.haul.remaining,25);
  assert.ok(revised.plan.haul.delivered>before.plan.haul.delivered);
  assert.deepEqual(revised.plan.reservations.filter(s=>s.trip===1),before.plan.reservations.filter(s=>s.trip===1));
  assert.equal((await call(path,{expectedRevision:2,minute:20,addedM3:50,repeatPassIds:['pass:ab:f']})).status,201);
  db.close();db=open();
  const attachment=await call('/'+id+'/export?revision=2');
  assert.match(attachment.headers.get('content-disposition'),/v2.json/);
  assert.deepEqual(await attachment.json(),revised);
  assert.deepEqual(await (await call('/'+id+'?revision=1')).json(),before);
  const latest=await (await call('/'+id)).json();
  assert.equal(latest.events.length,3);assert.equal(latest.plan.haul.delivered+latest.plan.haul.remaining,75);
  const repeat=latest.plan.reservations.find(s=>s.taskId==='episode-3-pass:ab:f');
  assert.ok(repeat && Date.parse(repeat.start)>=Date.parse(latest.plan.windowStart)+20*60000);
  assert.deepEqual(latest.plan.clearing.routes[0].legs.slice(0,before.plan.clearing.routes[0].legs.length),before.plan.clearing.routes[0].legs);
  assert.ok(latest.plan.haul.delivered<=50);validateUnifiedPlan(latest.plan);
});
