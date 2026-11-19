// Additional regression tests for the Snow Control planner.
// Copy this file to snow-control/backend/ and run `npm test`.
// The current implementation is expected to FAIL both tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './planner.mjs';

const vehicle = (id, workKmh, driveKmh = workKmh) => ({
  id, name: id, rate: 60, workKmh, driveKmh,
});
const task = (id, edgeId) => ({
  id, edgeId, name: id, reverse: false, priority: 1, targetMin: 999,
});
const road = (id, from, to, km) => ({ id, from, to, km, oneway: false, name: id });

test('greedy planner should cover all three feasible passes within 23 min', () => {
  // Exact route: d -> a (service 4) -> b (drive 5) -> c (service 5)
  // -> d (service 4) = 18 min. Yet current greedy planner serves only 2.
  const network = {
    depot: 'd', nodes: { d:[0,0], a:[1,0], b:[2,0], c:[3,0] },
    edges: [
      road('0','d','a',6), road('1','a','b',5), road('2','b','c',5),
      road('3','c','d',4), road('4','d','a',4),
    ],
  };
  const jobs = [task('t0','2'), task('t1','3'), task('t2','4')];
  const result = plan(network, jobs, [vehicle('v',60)], {
    vehicleIds:['v'],closed:[],budget:1000,shiftMin:23,strategy:'economy',
  });
  assert.equal(result.summary.assigned, 3,
    'There is a feasible 18-minute route serving all 3 jobs');
});

test('parallel strategy must not choose a 120-min route over 4-min fast plan', () => {
  const network = {
    depot: 'd', nodes: {d:[0,0],a:[1,0]},
    edges: [road('street','d','a',1)],
  };
  const jobs = [task('first','street'),task('second','street')];
  const fleet = [vehicle('fast',60),vehicle('slow',1)];
  const input = {vehicleIds:['fast','slow'],closed:[],budget:1000,shiftMin:500};
  const result = plan(network,jobs,fleet,{...input,strategy:'parallel'});
  const makespan = Math.max(...result.routes.map(route=>route.minutes));
  assert.ok(makespan<=4,
    `An available plan takes 4 min, but parallel chose ${makespan} min`);
});
