import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {api,createCatalog,calculateShift} from './service.mjs';
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

const scopeRow={edgeId:'r',operation:'patrol_plow',contractId:'demo',source:'Учебное приложение',clause:'1',reviewer:'А',
  customer:'Учебный заказчик',executor:'Учебный исполнитель',officer:'Дежурный',from:'2026-11-20',until:'2026-11-21'};
const scopePreview=(rows,extra={})=>preview({scenario:'attachment',attachment:{mode:'simulation',networkVersion:'unit',rows},...extra});
test('address schedule matches exact edge, shift date and operation; orphan rows stay visible',async()=>{
  const p=await scopePreview([scopeRow,{...scopeRow,edgeId:'unknown'}]);
  assert.equal(p.mode,'simulation');assert.equal(p.mandate.status,'eligible');assert.equal(p.routing.assigned,true);
  assert.equal(p.contract.document,scopeRow.source);assert.deepEqual(p.attachment.unmatched,[2]);
  for(const [change,status] of [[{edgeId:'return'},'outside'],[{from:'2026-11-21',until:'2026-11-22'},'inactive'],
    [{from:'2026-11-01',until:'2026-11-20'},'inactive'],[{operation:'anti_icing'},'operation_excluded']]){
    const q=await scopePreview([{...scopeRow,...change}]);
    assert.equal(q.attachment.status,status);assert.equal(q.mandate.status,'blocked');
    assert.equal(q.routing,null);assert.equal(q.responsibility,null);assert.deepEqual(q.actions,[]);
  }
});
test('bundled training annex fixes the covered road and identifies a row requiring manual review',async()=>{
  const network=JSON.parse(readFileSync(new URL('../data/city-network.json',import.meta.url),'utf8'));
  const city=createCatalog(network);
  const attachment=JSON.parse(readFileSync(new URL('../public/sever-training-scope.json',import.meta.url),'utf8'));
  const [covered,orphan]=attachment.rows;
  const run=(edgeId,file=attachment)=>api(null,'POST','/api/orders/preview',{...request,edgeId,scenario:'attachment',attachment:file},city);
  const inside=await run(covered.edgeId);
  assert.equal(inside.attachment.status,'covered');
  assert.equal(inside.mandate.status,'eligible');
  assert.equal(inside.responsibility.officer,covered.officer);
  assert.equal(inside.contract.customer,covered.customer);
  assert.equal(inside.contract.executor,covered.executor);
  assert.equal(inside.contract.document,covered.source);
  assert.deepEqual(inside.attachment.unmapped,[{line:2,edgeId:orphan.edgeId,contractId:orphan.contractId,source:orphan.source,
    clause:orphan.clause,operation:orphan.operation,from:orphan.from,until:orphan.until}]);
  const sameStreet=network.edges.find(edge=>edge.id!==covered.edgeId && edge.name===network.edges.find(e=>e.id===covered.edgeId).name);
  const outside=await run(sameStreet.id);
  assert.equal(outside.attachment.status,'outside');
  assert.equal(outside.mandate.status,'blocked');
  assert.equal(outside.routing,null);
  const review=await run(sameStreet.id,{...attachment,rows:[orphan]});
  assert.equal(review.attachment.status,'unmapped');
  assert.equal(review.mandate.status,'manual_review');
  assert.equal(review.routing,null);
  assert.deepEqual(review.actions,[]);
});
test('ambiguous scope blocks dispatch and a malformed dossier cannot start a route',async()=>{
  const p=await scopePreview([scopeRow,{...scopeRow,contractId:'second'}]);
  assert.equal(p.mandate.status,'blocked');assert.equal(p.routing,null);assert.deepEqual(p.actions,[]);
  for(const row of [{...scopeRow,clause:''},{...scopeRow,from:'2026-02-30'}])await assert.rejects(scopePreview([row]));
  for(const change of [{networkVersion:'other'},{mode:'verified'}])
    await assert.rejects(scopePreview([],{attachment:{mode:'simulation',networkVersion:'unit',rows:[scopeRow],...change}}));
});

test('two episodes select their own rule across the Kamchatka revision boundary',async()=>{
  const p=await preview({shift:{...shift,date:'2026-11-30',start:'23:50'},withEvent:true,repeatOffsetMin:10});
  assert.deepEqual(p.episodes.map(e=>e.rule.minutes),[120,90]);
  assert.deepEqual(p.episodes.map(e=>e.clock.dueAt),['2026-11-30T13:50:00.000Z','2026-11-30T13:30:00.000Z']);
  assert.notEqual(p.episodes[0].event.id,p.episodes[1].event.id);
  await assert.rejects(preview({withEvent:true,eventOffsetMin:15,repeatOffsetMin:15}));
  await assert.rejects(preview({repeatOffsetMin:5}));
});
test('clock requires the right source event, passport, queue and effective edition',async()=>{
  const ice={operation:'anti_icing',eventKind:'ice_detected',withEvent:true};
  const p=await preview(ice);assert.equal(p.rule.minutes,60);assert.ok(p.clock.dueAt);assert.equal(p.routing,null);
  assert.equal((await preview({...ice,eventKind:'snowfall_end'})).clock.status,'clock_unknown');
  assert.equal((await preview({...ice,queue:2})).clock.status,'needs_review');
  assert.equal((await preview({operation:'sidewalk',queue:2,objectType:'sidewalk',withEvent:true})).rule.minutes,240);
  assert.equal((await preview({...ice,shift:{...shift,date:'2028-01-01'}})).clock.status,'needs_review');
});

test('shift resource filters, full availability interval and worksite safety use the same saved card',async()=>{
  const machine={...data.fleet[0],type:'Учебная КДМ',availability:'reported',availabilitySource:'Журнал А',
    availableFrom:'2026-11-20T08:00',availableUntil:'2026-11-20T12:00',operations:['patrol_plow'],widthM:3,massT:10,maxGradePct:8};
  const withMachine=v=>({...shift,fleet:[v],vehicleIds:[v.id]});
  const good=withMachine(machine);
  assert.ok(calculateShift(data,good).result.summary.assigned>0);
  const ok=await preview({shift:good,worksite:{clearWidthM:3,maxMassT:10,gradePct:8}});
  assert.ok(ok.routing.assigned);
  for(const change of [{availableUntil:'2026-11-20T11:59'},{operations:['snow_haul']},{availability:'unknown'},{availability:'unavailable'}]){
    const input=withMachine({...machine,...change});
    const result=calculateShift(data,input).result;
    assert.equal(result.summary.assigned,0);assert.equal(result.excludedVehicles.length,1);
    assert.equal((await preview({shift:input})).routing,null);
  }
  for(const worksite of [{clearWidthM:2.9},{maxMassT:9},{gradePct:9}]){
    const p=await preview({shift:good,worksite});assert.equal(p.routing,null);assert.equal(p.mandate.status,'blocked');
  }
  assert.equal((await preview({shift:withMachine({...machine,widthM:null}),worksite:{clearWidthM:3}})).mandate.status,'manual_review');
  assert.throws(()=>calculateShift(data,withMachine({...machine,availabilitySource:''})));
});
