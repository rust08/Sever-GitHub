import test from 'node:test';
import assert from 'node:assert/strict';
import {api,createCatalog} from './service.mjs';
import {assessMandate,assessClock} from './governance.mjs';

const data=createCatalog({scope:'city',version:'unit',depot:'d',nodes:{d:[0,0],b:[1,0]},
  edges:[{id:'r',from:'d',to:'b',km:.1,oneway:true,highway:'primary'}]});
const shift={date:'2026-11-20',start:'08:00',shiftMin:240,budget:30000,vehicleIds:['kdm-01']};
// A two-way road is required here for the return to depot.
data.network.edges.push({id:'return',from:'b',to:'d',km:.1,oneway:true,highway:'service'});
const request={shift,shiftId:'s',edgeId:'r',operation:'patrol_plow',scenario:'example',history:[]};
const preview=(change={})=>api(null,'POST','/api/orders/preview',{...request,...change},data);
const step=(order,state,role)=>({orderId:order.id,state,role,actor:role,evidenceKind:state,evidence:'Учебный акт',at:'2026-11-20T03:00:00Z'});

test('T09/T24 unknown responsibility blocks routing and reports missing documents',async()=>{
  const p=await preview({scenario:'unknown'});assert.equal(p.mode,'simulation');assert.equal(p.mandate.status,'manual_review');
  assert.equal(p.routing,null);assert.ok(p.mandate.missing.length>=3);assert.deepEqual(p.actions,[]);
});
test('T08/T35 scope excludes an otherwise reachable road',async()=>{
  assert.equal((await preview()).routing.assigned,true);
  const p=await preview({scenario:'outside'});assert.equal(p.mandate.status,'blocked');assert.equal(p.routing,null);
});
test('T06/T07 distinct work types require independent authorization',async()=>{
  for(const operation of ['snow_haul','stop_cleaning','sidewalk']){
    const p=await preview({operation});assert.equal(p.mandate.status,'blocked');assert.equal(p.routing,null);
    if(operation==='snow_haul')assert.ok(p.mandate.missing.some(t=>t.includes('площадка')));
  }
});
test('T11 expired contract, wrong executor and incompatible resource prevent dispatch',async()=>{
  const p=await preview();const at=p.contract.start;
  for(const change of [{contract:{...p.contract,end:at}},{resource:{...p.resource,executor:'other'}},{resource:{...p.resource,operations:[]}}])
    assert.equal(assessMandate({...p,at,...change}).status,'blocked');
});
test('T01/T27 priority and shift start cannot start a regulatory clock',async()=>{
  assert.equal((await preview()).clock.status,'clock_unknown');
  const p=await preview({withEvent:true});assert.equal(p.clock.dueAt,'2026-11-19T22:00:00.000Z');assert.equal(p.clock.status,'scenario_deadline');
});
test('T02/T03/T04 start event, official classification and source version control clock',async()=>{
  const p=await preview({withEvent:true});
  assert.equal(assessClock({...p,event:{...p.event,kind:'ice_detected'}}).status,'clock_unknown');
  for(const change of [{asset:{...p.asset,legalClass:undefined,highway:'primary'}},{rule:{...p.rule,status:'outdated'}},{rule:{...p.rule,end:p.event.at}}])
    assert.equal(assessClock({...p,...change}).status,'needs_review');
});
test('T18/T21 demo contract cannot override a closure, prohibited direction or budget',async()=>{
  for(const change of [{shift:{...shift,closed:['r']}},{reverse:true},{shift:{...shift,budget:0}}]){
    const p=await preview(change);assert.equal(p.routing.assigned,false);assert.deepEqual(p.actions,[]);
  }
});
test('T05/T25/T26 independent attributed evidence for each stage; no GPS acceptance',async()=>{
  const p=await preview(),history=[];
  for(const [state,role] of [['dispatched','dispatcher'],['started','operator'],['machine_reported','operator'],['inspector_verified','inspector'],['accepted','customer']]){
    const entry=step(p,state,role);
    await assert.rejects(preview({history:[...history,{...entry,evidenceKind:'gps'}]}));
    await assert.rejects(preview({history:[...history,{...entry,orderId:'other'}]}));
    if(state==='accepted')await assert.rejects(preview({history:[...history,{...entry,role:'inspector'}]}));
    history.push(entry);assert.equal((await preview({history})).state,state);
  }
  assert.deepEqual((await preview({history})).actions,[]);
  await assert.rejects(preview({scenario:'unknown',history}));
});

test('selected shift vehicle determines the route and owns its journal',async()=>{
  const pair={...shift,vehicleIds:['kdm-01','kdm-02']};
  const first=await preview({shift:pair});
  const second=await preview({shift:pair,vehicleId:'kdm-02'});
  assert.equal(first.id,(await preview({shift:pair,vehicleId:'kdm-01'})).id);
  assert.equal(second.resource.id,'kdm-02');
  assert.equal(second.routing.vehicle,'КДМ-02');
  assert.notEqual(first.id,second.id);
  await assert.rejects(preview({shift:pair,vehicleId:'kdm-02',history:[step(first,'dispatched','dispatcher')]}));
  await assert.rejects(preview({vehicleId:'kdm-02'}),/машину/);
});
test('contract ending exactly at shift start blocks routing and dispatch',async()=>{
  const p=await preview({scenario:'expired'});
  assert.ok(Date.parse(p.contract.start)<Date.parse(p.contract.end));
  assert.equal(p.mandate.status,'blocked');
  assert.ok(p.mandate.conflicts.some(reason=>reason.includes('не действует')));
  assert.equal(p.routing,null);assert.deepEqual(p.actions,[]);
});
test('event time moves the illustrative deadline across local midnight',async()=>{
  const args={shift:{...shift,start:'23:40'},withEvent:true};
  const p=await preview({...args,eventOffsetMin:45});
  assert.equal(p.event.at,'2026-11-20T12:25:00.000Z');
  assert.equal(p.clock.dueAt,'2026-11-20T14:25:00.000Z');
  assert.notEqual(p.id,(await preview(args)).id);
  for(const eventOffsetMin of [-1,0.5,241])await assert.rejects(preview({...args,eventOffsetMin}),/Время события/);
  assert.equal((await preview({eventOffsetMin:45})).clock.status,'clock_unknown');
});
