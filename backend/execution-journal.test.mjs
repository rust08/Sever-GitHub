import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCatalog} from './service.mjs';
import {journalResponse} from './execution-journal.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('local simulator validates saved shifts, roles, transitions, retries and persistent history',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'snow-journal-'));
  const db=new DatabaseSync(join(dir,'dispatch.sqlite'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  db.exec('PRAGMA foreign_keys=ON');
  const migrations=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL(file,migrations),'utf8'));
  const data=createCatalog({scope:'city',version:'test',depot:'d',nodes:{d:[0,0],b:[1,0]},
    edges:[{id:'r',from:'d',to:'b',km:.1,oneway:false,highway:'primary'}]});
  const shift={date:'2026-11-20',start:'08:00',shiftMin:240,budget:30000,vehicleIds:['kdm-01']};
  db.prepare('INSERT INTO city_plans(network_version,id,shift_date,input_json,result_json) VALUES (?,?,?,?,?)')
    .run('test','shift',shift.date,JSON.stringify(shift),'{}');
  const url='http://localhost/api/work-orders';
  const post=(path,body,role,key)=>journalResponse(new Request(url+path,{method:'POST',
    headers:{'content-type':'application/json','x-simulation-role':role,'idempotency-key':key},
    body:JSON.stringify(body)}),db,data);
  const spec={shiftId:'shift',edgeId:'r',vehicleId:'kdm-01',operation:'patrol_plow'};
  assert.equal((await post('',{...spec,shiftId:'missing'},'dispatcher','a')).status,404);
  assert.equal((await post('',{...spec,operation:'snow_haul'},'dispatcher','a')).status,422);
  assert.equal((await post('',spec,'executor','a')).status,403);
  const created=await (await post('',spec,'dispatcher','a')).json();
  assert.equal(created.status,'created');
  assert.equal((await (await post('',spec,'dispatcher','a')).json()).id,created.id);
  assert.equal((await post('',spec,'dispatcher','duplicate')).status,409);
  const path='/'+created.id+'/events';
  const action=(version,type)=>({expected_version:version,event_type:type,comment:'Учебная запись',occurred_at:created.events[0].occurred_at});
  assert.equal((await post(path,action(1,'accepted'),'customer','skip')).status,409);
  const issued=action(1,'issued');
  const pair=await Promise.all(['b','c'].map(k=>post(path,issued,'dispatcher',k)));
  assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);
  assert.equal((await post(path,issued,'dispatcher',pair[0].ok?'b':'c')).status,200);
  let version=2;
  for(const [type,role] of [['started','executor'],['reported','executor'],['needs_rework','inspector'],
    ['started','executor'],['reported','executor'],['inspected','inspector']]){
    assert.equal((await post(path,action(version,type),role,'v'+version)).status,200);
    version++;
  }
  assert.equal((await post(path,{...action(version,'accepted'),role:'customer'},'executor','fake')).status,400);
  assert.equal((await post(path,action(version,'accepted'),'executor','fake')).status,403);
  const accepted=await (await post(path,action(version,'accepted'),'customer','ok')).json();
  assert.equal(accepted.events.length,version+1);
  assert.equal(accepted.status,'accepted');
  const summary=await journalResponse(new Request(url+'?shiftId=shift'),db,data);
  assert.deepEqual((await summary.json()).orders,[{id:created.id,status:'accepted',version:version+1}]);
  for(const states of [[['cancelled','dispatcher']],[
    ['issued','dispatcher'],['started','executor'],['reported','executor'],['inspected','inspector'],
    ['rejected','customer'],['disputed','executor']
  ]]){
    const shiftId=states.at(-1)[0];
    db.prepare('INSERT INTO city_plans(network_version,id,shift_date,input_json,result_json) VALUES (?,?,?,?,?)')
      .run('test',shiftId,shift.date,JSON.stringify(shift),'{}');
    let order=await (await post('',{...spec,shiftId},'dispatcher','create-'+shiftId)).json();
    for(const [type,role] of states){
      order=await (await post('/'+order.id+'/events',action(order.version,type),role,type)).json();
      assert.equal(order.status,type);
    }
    assert.equal(order.events.length,states.length+1);
  }
  // Start a fresh server process over the persisted fixture and repeat all migrations.
  const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'0',SNOW_DB_DIR:dir},stdio:['ignore','pipe','pipe']});
  const stopped=once(child,'exit');
  try{
    const [chunk]=await once(child.stdout,'data',{signal:AbortSignal.timeout(15000)});
    const address=chunk.toString().trim();
    const restored=await fetch(address+'/api/work-orders/'+created.id);
    assert.deepEqual(await restored.json(),accepted);
    const foreign=await fetch(address+'/api/work-orders/'+created.id,{headers:{origin:'https://example.org'}});
    assert.equal(foreign.status,403);
  }finally{child.kill();await stopped;}
});
