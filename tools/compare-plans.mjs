// Run from any directory: node tools/compare-plans.mjs
import { performance } from 'node:perf_hooks';
import { plan } from '../backend/planner.mjs';
import { fleetSeed, makePasses, priorityFor } from '../backend/policy.mjs';
import district from '../data/network.json' with {type:'json'};
import city from '../data/city-network.json' with {type:'json'};

const cityJobs = makePasses(city);
const scenarios = [
  ['Демо', district, makePasses(district)],
  ...[100, 500].map(n => [
    'Город, выборка', city,
    Array.from({length:n}, (_,i) => cityJobs[Math.floor(i * cityJobs.length / n)]),
  ]),
  ['Весь перечень', city, cityJobs],
];
const shift = {vehicleIds:fleetSeed.map(vehicle=>vehicle.id), closed:[], budget:30000, shiftMin:240};
console.log('Node', process.version, process.platform, process.arch);
console.log('Смена 240 мин, 30 000 ₽, три машины, без перекрытий. Первая задача каждого набора — сценарный срочный вызов.');
console.log('Выборки равномерно по индексам исходного перечня OSM. P1–P4: в срок / требуется. Время — один вызов plan(), без чтения файлов.');
const rows = [];
for (const [name,network,base] of scenarios) {
  const firstEdge = network.edges.find(edge=>edge.id===base[0].edgeId);
  const tasks = [{...base[0], ...priorityFor(firstEdge,true)}, ...base.slice(1)];
  const byId = new Map(tasks.map(job=>[job.id,job]));
  const required = [0,0,0,0];
  for (const task of tasks) required[task.priority-1]++;
  for (const strategy of ['economy','parallel']) {
    const start = performance.now();
    const result = plan(network,tasks,fleetSeed,{...shift,strategy});
    const elapsed = performance.now()-start;
    const onTime = [0,0,0,0];
    for (const route of result.routes) {
      for (const leg of route.legs) {
        if (leg.type !== 'work') continue;
        const task = byId.get(leg.taskId);
        if (leg.endMin <= task.targetMin) onTime[task.priority-1]++;
      }
    }
    rows.push({
      'Сценарий':name, 'Заданий':tasks.length, 'Режим':strategy, 'Назначено':result.summary.assigned,
      ...Object.fromEntries(onTime.map((count,i)=>['P'+(i+1),count+'/'+required[i]])),
      'Стоимость ₽':result.summary.cost,'Финиш, мин':Number(Math.max(0,...result.routes.map(route=>route.minutes)).toFixed(2)),
      'Холостой км':Number(result.summary.deadKm.toFixed(2)), 'Расчёт мс':Number(elapsed.toFixed(1)),
    });
  }
}
console.table(rows);