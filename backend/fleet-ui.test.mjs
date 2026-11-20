import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetModel} from '../public/fleet-ui.js';
import {api,createCatalog} from './service.mjs';

test('fleet editor serializes all machines independently of presentation order and retains legacy defaults',async()=>{
  const network={version:'fleet-test',scope:'city',depot:'a',nodes:{a:[0,0],b:[1,0]},
    edges:[{id:'ab',from:'a',to:'b',km:.1,highway:'primary'}]};
  const data=createCatalog(network);
  const loader={id:'extra',name:'Погрузчик',type:'Погрузчик',rate:3000,workKmh:8,driveKmh:10,
    availability:'reported',availableFrom:'2026-11-20T08:00',availableUntil:'2026-11-20T16:00',availabilitySource:'Учебная запись',
    operations:['snow_load'],widthM:3.1,massT:9,maxGradePct:7,tareKg:6000,payloadKg:2500,bodyM3:5};
  const model=createFleetModel([...data.fleet,loader],['kdm-01','extra'],{'kdm-01':4800});
  for(let n=0;n<100;n++){
    const vehicle={...loader,id:'machine-'+n,name:'Учебная '+n};
    model.entries.set(vehicle.id,{vehicle,active:n===17});
  }
  model.entries.get('machine-17').vehicle={...model.entries.get('machine-17').vehicle,massT:12};
  model.entries.delete('machine-35');
  const args=model.serialize();
  assert.equal(args.fleet.length,data.fleet.length+100);
  assert.deepEqual(args.vehicleIds,['kdm-01','extra','machine-17']);
  assert.equal(args.rates['kdm-01'],4800);
  assert.deepEqual(args.fleet[0].operations,['patrol_plow']);
  assert.equal(args.fleet[0].availability,'demo');
  assert.equal(args.fleet[0].type,'Снегоуборочная машина');
  const storage=[];
  const result=await api({batch:async entries=>storage.push(...entries)},'POST','/api/plans',{
    date:'2026-11-20',start:'08:00',shiftMin:240,budget:30000,...args},data);
  assert.equal(storage.length,1);
  const saved=result.input.fleet.find(v=>v.id==='machine-17');
  assert.equal(saved.massT,12);assert.equal(saved.availabilitySource,'Учебная запись');
  assert.deepEqual(saved.operations,['snow_load']);
  const restored=createFleetModel(result.input.fleet,result.input.vehicleIds,result.input.rates).serialize();
  assert.deepEqual(restored.vehicleIds,args.vehicleIds);
  assert.deepEqual(restored.fleet.find(v=>v.id==='extra'),loader);
});
