import test from 'node:test';
import assert from 'node:assert/strict';
import {plan} from './planner.mjs';

const road = (id, from, to, km, oneway = false) => ({id, from, to, km, oneway, name: id});
const network = {
  depot: 'd',
  nodes: {d:[0,0], a:[1,0], b:[2,0], c:[3,0]},
  edges: [road('da','d','a',4), road('ab','a','b',5,true), road('bc','b','c',5),
    road('cd','c','d',4,true), road('shortcut','a','b',1)],
};
const job = (id, edgeId, reverse = false) => ({id, edgeId, reverse, priority:1, targetMin:23, name:id});
const jobs = [job('middle','bc'),job('last','cd'),job('first','da'),
  job('closed','shortcut'),job('wrong-way','ab',true)];
const fleet = [{id:'plow', name:'Отвал', rate:60.01, workKmh:60, driveKmh:60}];

test('repaired shift accounts for each legal pass, return, seconds and rounded fare', () => {
  const shift = {vehicleIds:['plow'],closed:['shortcut'],budget:18.01,shiftMin:23,strategy:'economy'};
  const result = plan(network,jobs,fleet,shift);
  const edges = new Map(network.edges.map(edge => [edge.id,edge]));
  const tasks = new Map(jobs.map(task => [task.id,task]));
  const assigned = [];
  const [route] = result.routes;
  let position = network.depot;
  let seconds = 0;
  let deadKm = 0;
  for (const leg of route.legs) {
    const edge = edges.get(leg.edgeId);
    assert.ok(edge && !shift.closed.includes(edge.id));
    assert.equal(leg.from,position);
    assert.ok((edge.from === leg.from && edge.to === leg.to) ||
      (!edge.oneway && edge.from === leg.to && edge.to === leg.from));
    assert.equal(leg.startMin * 60,seconds);
    seconds += edge.km * 60;
    assert.equal(leg.endMin * 60,seconds);
    if (leg.type === 'work') {
      const task = tasks.get(leg.taskId);
      assert.equal(task.edgeId,edge.id);
      assert.equal(leg.from,task.reverse ? edge.to : edge.from);
      assert.ok(leg.endMin <= task.targetMin);
      assigned.push(task.id);
    } else {
      assert.equal(leg.type,'drive');
      deadKm += edge.km;
    }
    position = leg.to;
  }
  assert.equal(position,network.depot);
  assert.deepEqual(assigned.sort(),['first','last','middle']);
  assert.deepEqual(result.unassigned.map(x => x.taskId).sort(),['closed','wrong-way']);
  assert.equal(seconds,18*60);
  assert.equal(route.minutes,seconds/60);
  assert.ok(route.minutes <= shift.shiftMin);
  assert.equal(route.cost,Math.ceil(seconds*6001/3600)/100);
  assert.ok(route.cost <= shift.budget);
  assert.equal(route.deadKm,deadKm);
  assert.deepEqual(result.summary,{cost:route.cost,deadKm,assigned:3,total:5,onTime:3,urgentTotal:5,urgentOnTime:3});
});