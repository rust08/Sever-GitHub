import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './planner.mjs';
import cityNetwork from '../data/network.json' with { type: 'json' };
import { fleetSeed, makePasses, priorityFor } from './policy.mjs';

const nodes = { d: [0, 0], a: [1, 0], b: [1, 1] };
const road = (id, from, to, km = 1, oneway = false) => ({ id, from, to, km, oneway, name: id });
const network = {
  nodes, depot: 'd', edges: [road('base', 'd', 'a'), road('main', 'a', 'b', 1, true), road('return', 'b', 'd', 1, true)],
};
const fleet = [{ id: 'v', name: 'КДМ', rate: 60, workKmh: 30, driveKmh: 60 }];
const shift = { vehicleIds: ['v'], closed: [], budget: 4, shiftMin: 4 };
const pass = (id, edgeId, priority = 1, targetMin = 3) => ({ id, edgeId, name: id, priority, targetMin, reverse: false });
const task = pass('p', 'main');

test('work requires the directed edge and includes the return fare and time', () => {
  const result = plan(network, [task], fleet, shift);
  assert.deepEqual(result.summary, { cost: 4, deadKm: 2, assigned: 1, total: 1, onTime: 1, urgentTotal: 1, urgentOnTime: 1 });
  assert.deepEqual(result.routes[0].legs.map(s => [s.type, s.from, s.to, s.startMin, s.endMin]), [
    ['drive', 'd', 'a', 0, 1], ['work', 'a', 'b', 1, 3], ['drive', 'b', 'd', 3, 4],
  ]);
});

test('blocked return, closed work edge and prohibited direction have individual reasons', () => {
  assert.match(plan(network, [task], fleet, { ...shift, closed: ['return'] }).unassigned[0].reason, /проезда/);
  assert.match(plan(network, [task], fleet, { ...shift, closed: ['main'] }).unassigned[0].reason, /перекрыта/);
  assert.match(plan(network, [{ ...task, reverse: true }], fleet, shift).unassigned[0].reason, /направление/);
});

test('resource constraints differentiate money, shift and unavailable vehicles', () => {
  for (const [changes, pattern] of [[{ budget: 3.99 }, /бюджета/], [{ shiftMin: 3 }, /времени/], [{ vehicleIds: [] }, /техника/]]) {
    const result = plan(network, [task], fleet, { ...shift, ...changes });
    assert.equal(result.summary.cost, 0);
    assert.equal(result.summary.assigned, 0);
    assert.match(result.unassigned[0].reason, pattern);
  }
});

test('a low-priority insertion cannot break an earlier commitment; a late feasible job stays visible', () => {
  const urgent = pass('urgent', 'main', 1, 3);
  const local = pass('local', 'base', 4, 1);
  const result = plan(network, [local, urgent], fleet, { ...shift, budget: 20, shiftMin: 20 });
  const work = result.routes[0].legs.filter(leg => leg.type === 'work');
  assert.deepEqual(work.map(leg => leg.taskId), ['urgent', 'local']);
  assert.equal(result.summary.onTime, 1);
  assert.equal(result.summary.urgentOnTime, 1);
  assert.ok(work[1].endMin > local.targetMin);
});

test('two requested passes on the same two-way edge remain separate', () => {
  const graph = { nodes, depot: 'd', edges: [road('r', 'd', 'a')] };
  const both = [pass('out', 'r'), { ...pass('back', 'r'), reverse: true }];
  const result = plan(graph, both, fleet, { ...shift, shiftMin: 20, budget: 20 });
  assert.deepEqual(result.routes[0].legs.map(leg => [leg.type, leg.taskId, leg.from, leg.to]), [
    ['work', 'out', 'd', 'a'], ['work', 'back', 'a', 'd'],
  ]);
  assert.equal(result.summary.deadKm, 0);
});

test('charging uses whole kopecks per vehicle and never exceeds the limit', () => {
  const cheap = [{ ...fleet[0], rate: 1 }];
  const accepted = plan(network, [task], cheap, { ...shift, budget: 0.07 });
  const rejected = plan(network, [task], cheap, { ...shift, budget: 0.06 });
  assert.equal(accepted.summary.cost, 0.07);
  assert.equal(rejected.summary.assigned, 0);
});

test('competing classes respect P1 before P4 when funds cover one task', () => {
  const result = plan(network, [pass('local', 'base', 4), task], fleet, shift);
  assert.deepEqual(result.routes[0].legs.filter(leg => leg.type === 'work').map(leg => leg.taskId), ['p']);
  assert.equal(result.unassigned[0].taskId, 'local');
});

test('two machines work in parallel and share one budget', () => {
  const graph = { nodes, depot: 'd', edges: [road('west', 'd', 'a'), road('east', 'd', 'b')] };
  const trucks = [...fleet, { ...fleet[0], id: 'w', name: 'КДМ-2' }];
  const inputs = { ...shift, vehicleIds: ['v', 'w'], shiftMin: 3, budget: 6 };
  const jobs = [pass('w1', 'west', 1, 2), pass('e1', 'east', 1, 2)];
  const both = plan(graph, jobs, trucks, inputs);
  assert.equal(both.summary.urgentOnTime, 2);
  assert.equal(both.summary.cost, 6);
  assert.deepEqual(both.routes.map(route => route.minutes), [3, 3]);
  const limited = plan(graph, jobs, trucks, { ...inputs, budget: 5.99 });
  assert.equal(limited.summary.assigned, 1);
  assert.equal(limited.summary.cost, 3);
});

test('three selected machines share the city shift and preserve service targets within budget', () => {
  const edges = new Map(cityNetwork.edges.map(edge => [edge.id, edge]));
  const jobs = makePasses(cityNetwork).map(job => ({
    ...job, ...priorityFor(edges.get(job.edgeId), job.id === 'road-1'),
  }));
  const input = { vehicleIds: fleetSeed.map(v => v.id), closed: [], budget: 30000, shiftMin: 240 };
  const economical = plan(cityNetwork, jobs, fleetSeed, { ...input, strategy: 'economy' });
  const parallel = plan(cityNetwork, jobs, fleetSeed, { ...input, strategy: 'parallel' });
  assert.equal(jobs.length, 21);
  assert.equal(parallel.routes.filter(route => route.legs.length).length, 3);
  assert.equal(parallel.summary.onTime, jobs.length);
  assert.equal(economical.summary.onTime, jobs.length);
  assert.ok(Math.max(...parallel.routes.map(r => r.minutes)) < Math.max(...economical.routes.map(r => r.minutes)));
  assert.ok(parallel.summary.cost <= input.budget);
  assert.ok(economical.summary.cost <= parallel.summary.cost);

  const tightInput = { ...input, budget: 3000 };
  const tightParallel = plan(cityNetwork, jobs, fleetSeed, { ...tightInput, strategy: 'parallel' });
  const tightEconomical = plan(cityNetwork, jobs, fleetSeed, { ...tightInput, strategy: 'economy' });
  assert.ok(tightParallel.summary.cost <= tightInput.budget);
  assert.ok(tightParallel.summary.assigned >= tightEconomical.summary.assigned);
  assert.ok(tightParallel.summary.urgentOnTime >= tightEconomical.summary.urgentOnTime);
});
