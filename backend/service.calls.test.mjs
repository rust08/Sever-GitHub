import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { api, createCatalog, InputError } from './service.mjs';

const segment = (id, from, to, options = {}) => ({id, from, to, km:0.1, highway:'service', name:id, ...options});
const data = createCatalog({scope:'city', version:'test', depot:'d', nodes:{d:[0,0], a:[1,0], b:[2,0]},
  edges:[segment('main','d','a',{highway:'residential'}), segment('hospital:gate','a','b'),
    segment('only','b','d',{oneway:true}), segment('closed-access','d','b',{routable:false})]});
const shift = {date:'2026-11-20', start:'08:00', shiftMin:240, budget:30000, vehicleIds:['kdm-01']};

test('shift API adds only confirmed directions, persists enough data to reopen calls and keeps the catalog stable', async t => {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(readFileSync(new URL('../drizzle/0001_city_plans.sql',import.meta.url),'utf8'));
  const db = {
    rows: (query, args) => sql.prepare(query).all(...args),
    batch: statements => { for (const [query,args] of statements) sql.prepare(query).run(...args); },
  };
  const optional = 'pass:hospital:gate:r', regular = 'pass:main:f';
  const ids = [optional, regular];
  const {result} = await api(db,'POST','/api/plans',{...shift,incidents:ids},data);
  assert.equal(result.summary.total, data.tasks.length+1);
  assert.equal(result.summary.urgentOnTime, 2);
  assert.deepEqual(result.priorities.map(p=>p.id),ids);
  assert.deepEqual(result.priorities[0], {id:optional,edgeId:'hospital:gate',name:'hospital:gate · обратно',
    reverse:true,priority:1,reason:result.priorities[0].reason,targetMin:45});
  assert.ok(result.priorities[0].reason);
  assert.ok(!result.routes.flatMap(r=>r.legs).some(l=>l.taskId==='pass:hospital:gate:f'));
  const reload = await api(db,'GET','/api/data',null,data);
  assert.deepEqual(reload.latest.input.incidents,ids);
  assert.deepEqual(reload.latest.result.priorities,result.priorities);
  assert.ok(!reload.tasks.some(t=>t.id===optional));
  const blocked = await api(db,'POST','/api/plans',{...shift,incidents:[optional],closed:['hospital:gate']},data);
  assert.match(blocked.result.unassigned.find(t=>t.taskId===optional).reason,/перекрыта/);
  const without = await api(db,'POST','/api/plans',shift,data);
  assert.equal(without.result.summary.total,data.tasks.length);
  assert.deepEqual(without.result.priorities,[]);
});
test('shift API rejects unknown, restricted, duplicate and wrong-way calls', async () => {
  for (const incidents of [['pass:missing:r'], ['pass:closed-access:f'], ['pass:only:r'],
    ['pass:main:f','pass:main:f'], [7], 'pass:main:f']) {
    await assert.rejects(api(null,'POST','/api/plans',{...shift,incidents},data),InputError);
  }
});

test('large saved shifts compress repeated reasons and restore the full API result alongside legacy JSON', async () => {
  const edges = Array.from({length:800}, (_,i)=> segment('city-'+i,'d','a',{highway:'residential'}));
  const big = createCatalog({...data.network, edges});
  let row;
  const db = {
    batch: ([[_query,args]])=>{ row = {id:args[1],input_json:args[3],result_json:args[4]}; },
    rows: ()=>[row],
  };
  const saved = await api(db,'POST','/api/plans',{...shift,budget:0},big);
  const original = JSON.stringify(saved.result);
  assert.ok(Buffer.byteLength(row.result_json) < Buffer.byteLength(original)/3);
  const restored = await api(db,'GET','/api/data',null,big);
  assert.deepEqual(restored.latest.result,saved.result);
  row.result_json = original;
  assert.deepEqual((await api(db,'GET','/api/data',null,big)).latest.result,saved.result);
});
