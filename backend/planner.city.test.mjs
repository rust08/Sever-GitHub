import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './planner.mjs';
import { makePasses, passesForEdge } from './policy.mjs';

const road = (id, from, to, attributes = {}) => ({ id, from, to, km: 1, highway: 'residential', ...attributes });
const network = { scope: 'city', depot: 'd', nodes: {d:[0,0], a:[1,0], b:[2,0], p:[5,0], q:[6,0]},
  edges: [road('cross','d','a',{highway:'service'}),road('main','a','b',{highway:'primary', oneway:true}),
    road('return','b','a',{highway:'service',oneway:true}),road('local','d','p'),
    road('private','p','q',{routable:false}),road('island','q','q')] };
const fleet = [{id:'plow',name:'A',rate:60.01,driveKmh:60,workKmh:60}];
const input = { vehicleIds:['plow'],strategy:'parallel',closed:[],shiftMin:4,budget:4.01 };

test('city policy gives stable work IDs to every required legal direction including unnamed roads', () => {
  const jobs = makePasses(network);
  assert.deepEqual(jobs.map(j=>j.id),['pass:main:f','pass:local:f','pass:local:r','pass:island:f','pass:island:r']);
  assert.equal(jobs[0].priority,2);
  assert.ok(jobs.every(j=>j.name));
});

test('city plan reserves depot return, obeys one-way, closures and priority, charges kopecks', () => {
  const jobs = makePasses(network);
  const result = plan(network,jobs,fleet,input);
  const [route] = result.routes;
  assert.deepEqual(route.legs.map(l=>[l.type,l.edgeId]),[['drive','cross'],['work','main'],['drive','return'],['drive','cross']]);
  assert.deepEqual(route.legs.map(l=>[l.from,l.to]),[['d','a'],['a','b'],['b','a'],['a','d']]);
  assert.equal(route.cost,4.01);
  assert.equal(result.summary.onTime,1);
  assert.equal(result.summary.assigned,1);
  assert.equal(result.coverage.networkKm,6);
  assert.equal(result.coverage.requiredNetworkKm,3);
  assert.equal(result.coverage.fullyAssignedKm,1);
  assert.match(result.unassigned.find(t=>t.taskId==='pass:island:f').reason,/Нет проезда/);
  const closed = plan(network,jobs,fleet,{...input,closed:['return','local']});
  assert.equal(closed.summary.assigned,0);
  assert.match(closed.unassigned.find(t=>t.taskId==='pass:main:f').reason,/Нет проезда/);
  assert.match(closed.unassigned.find(t=>t.taskId==='pass:local:f').reason,/перекрыта/);
});

test('city coverage counts a bidirectional segment once and distinguishes a single direction', () => {
  const graph = {...network, edges: [road('twoway','d','a')]};
  const jobs = makePasses(graph);
  const slowWork = [{...fleet[0], workKmh:30}];
  const one = plan(graph,jobs,slowWork,{...input,shiftMin:3});
  assert.equal(one.coverage.partiallyAssignedKm,1);
  assert.equal(one.coverage.fullyAssignedKm,0);
  const both = plan(graph,jobs,slowWork,{...input,shiftMin:4});
  assert.equal(both.coverage.fullyAssignedKm,1);
  assert.equal(both.coverage.partiallyAssignedKm,0);
  assert.equal(both.summary.assigned,2);
});


test('confirmed calls can request a legal direction on a transit-only road', () => {
  const access = road('hospital', 'd', 'a', { highway: 'service', serviceRequired: false });
  const graph = { ...network, edges: [access] };
  assert.deepEqual(makePasses(graph), []);
  const [outbound, urgent] = passesForEdge(access, true);
  assert.equal(urgent.priority, 1);
  assert.equal(urgent.targetMin, 45);
  const result = plan(graph, [urgent], fleet, input);
  assert.equal(result.summary.urgentOnTime, 1);
  assert.deepEqual(result.routes[0].legs.filter(l => l.type === 'work').map(l => l.taskId), [urgent.id]);
  assert.equal(result.coverage.requiredTasks, 1);
  assert.deepEqual(passesForEdge({...access, routable:false}, true), []);
  assert.deepEqual(passesForEdge({...access, oneway:true}, true).map(t => t.id), [outbound.id]);
});
