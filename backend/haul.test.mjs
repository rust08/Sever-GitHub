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
