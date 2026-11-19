import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './planner.mjs';

// All edges in these fixtures are one km, and all trucks move at 60 km/h.
// Thus every work or transfer edge costs one minute. Integer tariffs below
// give exact kopecks per minute. BFS is independent of planner pathfinding.
function oracle(graph, jobs, fleet, input) {
  const closed = new Set(input.closed);
  const neighbours = new Map(Object.keys(graph.nodes).map(node => [node, []]));
  for (const edge of graph.edges) {
    if (closed.has(edge.id)) continue;
    neighbours.get(edge.from).push(edge.to);
    if (!edge.oneway) neighbours.get(edge.to).push(edge.from);
  }
  function distance(from, to) {
    const steps = new Map([[from, 0]]);
    const queue = [from];
    for (const node of queue) {
      if (node === to) return steps.get(node);
      for (const next of neighbours.get(node)) {
        if (steps.has(next)) continue;
        steps.set(next, steps.get(node) + 1);
        queue.push(next);
      }
    }
    return Infinity;
  }
  const orders = fleet.map(() => []);
  let best = Array(8).fill(0);
  function scoreAssignment() {
    const score = Array(8).fill(0);
    let cost = 0;
    for (const [index, jobs] of orders.entries()) {
      let position = graph.depot;
      let time = 0;
      for (const job of jobs) {
        const edge = graph.edges.find(edge => edge.id === job.edgeId);
        if (closed.has(edge.id) || (job.reverse && edge.oneway)) return;
        time += distance(position, job.reverse ? edge.to : edge.from) + 1;
        position = job.reverse ? edge.from : edge.to;
        const bucket = (job.priority - 1) * 2;
        score[bucket] += Number(time <= job.targetMin);
        score[bucket + 1]++;
      }
      time += distance(position, graph.depot);
      if (time > input.shiftMin) return;
      cost += Math.ceil(time * fleet[index].rate * 100 / 60);
    }
    if (cost > Math.round(input.budget * 100)) return;
    const unequal = score.findIndex((value, i) => value !== best[i]);
    if (unequal >= 0 && score[unequal] > best[unequal]) best = score;
  }
  // Insert each task anywhere on any vehicle, or leave it out.
  function visit(index) {
    if (index === jobs.length) return scoreAssignment();
    visit(index + 1);
    for (const order of orders) {
      for (let slot = 0; slot <= order.length; slot++) {
        order.splice(slot, 0, jobs[index]);
        visit(index + 1);
        order.splice(slot, 1);
      }
    }
  }
  visit(0);
  return best;
}

test('priority coverage agrees with exhaustive allocation on small directed networks', () => {
  const graph = {depot:'d', nodes:{d:[0,0],a:[1,0],b:[0,1]}, edges:[
    {id:'west',from:'d',to:'a',oneway:false,km:1},
    {id:'east',from:'d',to:'b',oneway:false,km:1},
    {id:'link',from:'a',to:'b',oneway:true,km:1},
  ]};
  const jobs = [
    {id:'westward',edgeId:'west',priority:1,targetMin:1},
    {id:'linkward',edgeId:'link',priority:2,targetMin:3},
    {id:'back',edgeId:'east',reverse:true,priority:4,targetMin:6},
  ];
  const fleet = ['a','b'].map((id,i) => ({id, name:id, rate:60*(1+i), workKmh:60,driveKmh:60}));
  for (const closed of [[],['link'],['east']]) {
    for (const budget of [2,5,20]) {
      for (const strategy of ['parallel','economy']) {
        const input = {budget,closed,strategy,shiftMin:5,vehicleIds:fleet.map(truck=>truck.id)};
        const expected = oracle(graph,jobs,fleet,input);
        const result = plan(graph,jobs,fleet,input);
        const actual = Array(8).fill(0);
        for (const leg of result.routes.flatMap(route=>route.legs)) {
          if (leg.type !== 'work') continue;
          const job = jobs.find(job => job.id === leg.taskId);
          const bucket = (job.priority - 1) * 2;
          actual[bucket] += Number(leg.endMin <= job.targetMin);
          actual[bucket + 1]++;
        }
        assert.deepEqual(actual, expected, JSON.stringify(input));
      }
    }
  }
});