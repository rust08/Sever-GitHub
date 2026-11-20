import test from 'node:test';
import assert from 'node:assert/strict';
import {api,createCatalog} from './service.mjs';
import {validateUnifiedPlan} from './unified-shift.mjs';

const data=createCatalog({scope:'city',version:'small',depot:'a',nodes:{a:[0,0],b:[1,0],c:[2,0]},edges:[
  {id:'road',from:'a',to:'b',km:1,highway:'primary'},{id:'bridge',from:'b',to:'c',km:1,highway:'service'}]});
const vehicle={type:'учебная',driveKmh:30,workKmh:10,rate:600};
const fleet=[{...vehicle,id:'plow',name:'КДМ',operations:['patrol_plow']},
  {...vehicle,id:'loader',name:'Погрузчик',operations:['snow_load']},
  ...['t1','t2'].map(id=>({...vehicle,id,name:id,operations:['snow_haul','snow_unload'],bodyM3:4,payloadKg:2000,tareKg:6000}))];
const shift={date:'2026-11-20',start:'08:00',shiftMin:120,budget:10000,vehicleIds:fleet.map(v=>v.id),fleet};
const options={fleetMode:'shift',travelMode:'network',volume:12,siteCapacity:12,densityKgM3:500,loadRate:120,
  unloadMin:5,siteBusyUntil:20,sitePermitted:true,loadNode:'a',siteNode:'c'};
const run=(changes={},haul={})=>api(null,'POST','/api/unified-shifts/preview',{shift:{...shift,...changes},options:{...options,...haul}},data);
test('shared shift reserves plow, loader, trucks and one post within one budget',async()=>{
  const p=await run();
  assert.ok(p.clearing.summary.assigned>0);assert.equal(p.haul.delivered,12);
  assert.ok(p.reservations.some(s=>s.kind==='wait'));
  assert.deepEqual(await run(),p);
  assert.equal(p.spentCents,Math.round(p.clearing.summary.cost*100)+p.haul.trips.reduce((sum,t)=>sum+t.cents,0));
  const work=p.reservations.find(s=>s.kind==='plow');
  const post=p.reservations.find(s=>s.kind==='unload'&&s.resourceType==='unload_post');
  for(const slot of [work,post])assert.throws(()=>validateUnifiedPlan({...p,reservations:[...p.reservations,slot]}),/Пересечение/);
  assert.throws(()=>validateUnifiedPlan({...p,budgetCents:p.spentCents-1}),/бюджета/);
  const tight=await run({budget:p.clearing.summary.cost});
  assert.equal(tight.haul.delivered,0);assert.match(tight.haul.reason,/бюджета/);
  assert.equal((await run({closed:['bridge']})).haul.delivered,0);
  const limited=await run({},{transitLimits:[{edgeId:'bridge',maxKg:6000,source:'учебный предел'}]});
  assert.equal(limited.haul.delivered,0);
  assert.match(limited.haul.reason,/пути/);
});
test('multi-purpose truck may haul only after returning to the loading depot',async()=>{
  const machines=[{...fleet[2],operations:[...fleet[2].operations,'patrol_plow']},fleet[1]];
  const selected={fleet:machines,vehicleIds:machines.map(v=>v.id)};
  const p=await run(selected);
  assert.ok(p.haul.delivered>0);
  assert.ok(p.haul.trips[0].start>=p.clearing.routes[0].minutes);
  const remote=await run(selected,{loadNode:'b'});
  assert.deepEqual(remote.unavailableAtLoadNode,['t1']);
  assert.equal(remote.haul.delivered,0);
});
