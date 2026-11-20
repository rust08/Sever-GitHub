import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateHaul} from './haul.mjs';
const shift={date:'2026-11-20',start:'08:00',shiftMin:240,budget:30000,vehicleIds:[]};
const options={fleetMode:'sample',volume:60,siteCapacity:60,loadRate:60,driveMin:15,unloadMin:10,siteBusyUntil:60,sitePermitted:true};
test('haul resources never overlap, queue and return are charged once',()=>{
  const p=calculateHaul(shift,[],options);
  assert.equal(p.delivered,60);assert.equal(p.remaining,0);
  const free=new Map();let loader=0,site=60,cents=0;
  for(const t of p.trips){
    assert.ok(t.start>=loader && t.start>=(free.get(t.truckId)??0));
    assert.equal(t.unload,Math.max(site,t.arrive));assert.ok(t.back<=shift.shiftMin);
    site=t.finish;loader=t.depart;free.set(t.truckId,t.back);
    cents+=Math.ceil(((t.depart-t.start)*300000+(t.back-t.start)*240000)/60);
  }
  assert.equal(cents/100,p.cost);assert.equal(p.trips[0].wait,35);
});
test('haul stops at site capacity, budget, shift end and missing permission',()=>{
  const run=(limits={},changes={})=>calculateHaul({...shift,...limits},[],{...options,siteBusyUntil:0,...changes});
  assert.equal(run({},{siteCapacity:13}).delivered,13);
  assert.equal(run({shiftMin:43}).delivered,3);
  assert.equal(run({budget:1690}).delivered,1);
  assert.equal(run({budget:1689}).trips.length,0);
  assert.equal(run({},{sitePermitted:false}).trips.length,0);
  assert.equal(run({},{fleetMode:'shift'}).trips.length,0);
  assert.throws(()=>run({},{driveMin:0}));
});
test('haul uses selected distinct resources and checks availability and unloading capability',()=>{
  const truck={id:'t',name:'Самосвал',rate:100,operations:['snow_load','snow_haul','snow_unload'],bodyM3:6};
  const loader={id:'l',name:'Погрузчик',rate:200,operations:['snow_load']};
  const run=(fleet,ids)=>calculateHaul({...shift,vehicleIds:ids},fleet,{...options,fleetMode:'shift'});
  assert.equal(run([truck],['t']).delivered,0);
  const result=run([truck,loader],['l','t']);assert.equal(result.loader,loader.name);assert.ok(result.delivered>0);
  for(const change of [{availability:'unknown'},{bodyM3:null},{operations:['snow_haul']}]){
    assert.equal(run([{...truck,...change},loader],['t','l']).delivered,0);
  }
});

test('network haul uses independent directed paths, excludes closed and restricted edges, and charges the actual return',()=>{
  const network={nodes:{a:[0,0],b:[1,0],c:[1,1]},edges:[
    {id:'out',from:'a',to:'b',km:2,oneway:true},{id:'around',from:'b',to:'c',km:3,oneway:true},
    {id:'home',from:'c',to:'a',km:1,oneway:true},{id:'restricted',from:'b',to:'a',km:0.5,routable:false}]};
  const params={...options,volume:10,siteBusyUntil:0,travelMode:'network',loadNode:'a',siteNode:'b'};
  const run=(closed=[],changes={})=>calculateHaul({...shift,closed},[],{...params,...changes},network);
  const r=run();assert.deepEqual(r.paths.outward.edges,['out']);assert.deepEqual(r.paths.home.edges,['around','home']);
  const trip=r.trips[0];assert.equal(trip.arrive-trip.depart,6);assert.equal(trip.back-trip.finish,12);
  assert.equal(r.cost,2020);assert.equal(run(['home']).delivered,0);assert.match(run(['home']).reason,/обратного/);
  assert.equal(run(['out']).paths.outward,null);assert.throws(()=>run([],{siteNode:'a'}));assert.throws(()=>run([],{siteNode:'unknown'}));
});

test('payload limits each trip and site capacity can require a partial last load',()=>{
  const run=(extra={})=>calculateHaul(shift,[],{...options,siteCapacity:13,siteBusyUntil:0,...extra});
  const result=run({densityKgM3:800});
  assert.deepEqual(result.trips.map(t=>t.amount),[6,6,1]);
  assert.deepEqual(result.trips.map(t=>t.cargoKg),[4800,4800,800]);
  assert.equal(result.totalCargoKg,10400);
  assert.deepEqual(run().trips.map(t=>t.amount),[10,3]);
  assert.equal(run().totalCargoKg,null);
  assert.equal(run({densityKgM3:500}).trips[0].amount,10);
  assert.equal(run({densityKgM3:5001}).excluded.length,2);
  for(const densityKgM3 of [0,-1,0.5,'800'])assert.throws(()=>run({densityKgM3}));
});
test('mass calculation excludes only trucks with missing or insufficient payload',()=>{
  const loader={id:'l',name:'L',rate:100,operations:['snow_load']};
  const truck={id:'t',name:'T',rate:100,bodyM3:10,operations:['snow_haul','snow_unload']};
  const fleet=[loader,truck,{...truck,id:'u',payloadKg:7000}];
  const p=calculateHaul({...shift,vehicleIds:['l','t','u']},fleet,{...options,fleetMode:'shift',densityKgM3:1000});
  assert.deepEqual(p.excluded.map(v=>v.id),['t']);
  assert.ok(p.trips.length);assert.ok(p.trips.every(t=>t.truckId==='u' && t.cargoKg<=7000));
});

test('loaded outbound detours, empty return and light final load use the restricted short road',()=>{
  const network={nodes:{a:[0,0],b:[1,0],c:[0,1]},edges:[
    {id:'bridge',from:'a',to:'b',km:1},{id:'detour1',from:'a',to:'c',km:2},{id:'detour2',from:'c',to:'b',km:2}]};
  const params={...options,travelMode:'network',loadNode:'a',siteNode:'b',volume:12,siteBusyUntil:0,densityKgM3:500,
    transitLimits:[{edgeId:'bridge',maxKg:9000,source:'Учебная схема'}]};
  const run=(closed=[],changes={})=>calculateHaul({...shift,closed},[],{...params,...changes},network);
  const p=run(),first=p.routeSets[p.trips[0].routeIndex],last=p.routeSets[p.trips.at(-1).routeIndex];
  assert.deepEqual(first.outward.edges,['detour1','detour2']);assert.deepEqual(first.home.edges,['bridge']);
  assert.deepEqual(last.outward.edges,['bridge']);assert.equal(p.trips[0].arrive-p.trips[0].depart,12);
  const partial=run(['detour1']);assert.equal(partial.delivered,12);assert.ok(partial.trips.every(t=>t.amount<=2));
  assert.equal(run(['detour1'],{densityKgM3:null}).delivered,0);
  for(const rule of [{widthM:2},{gradePct:9},{maxKg:7999}]){
    assert.equal(run(['detour1'],{transitLimits:[{edgeId:'bridge',source:'Учебная схема',...rule}]}).delivered,0);
  }
  assert.throws(()=>run([],{transitLimits:[{edgeId:'other',maxKg:8000,source:'test'}]}));
});
