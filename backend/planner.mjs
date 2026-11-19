// Directed shortest paths for transfers; required passes keep their own direction.
function buildTransfers(network, closed) {
  const graph = new Map(Object.keys(network.nodes).map(id => [id, []]));
  for (const edge of network.edges) {
    if (closed.has(String(edge.id))) continue;
    const from = String(edge.from);
    const to = String(edge.to);
    if (!graph.has(from) || !graph.has(to) || !(edge.km > 0)) {
      throw new Error('Некорректная геометрия дорожного графа');
    }
    graph.get(from).push({ edge, from, to });
    if (!edge.oneway) graph.get(to).push({ edge, from: to, to: from });
  }
  const cache = new Map();
  return function transfer(from, to) {
    if (!cache.has(from)) {
      const distances = new Map([[from, 0]]);
      const previous = new Map();
      const open = new Set([from]);
      while (open.size) {
        let current;
        for (const id of open) {
          if (current === undefined || distances.get(id) < distances.get(current)) current = id;
        }
        open.delete(current);
        for (const arc of graph.get(current)) {
          const distance = distances.get(current) + arc.edge.km;
          if (distance >= (distances.get(arc.to) ?? Infinity)) continue;
          distances.set(arc.to, distance);
          previous.set(arc.to, arc);
          open.add(arc.to);
        }
      }
      cache.set(from, { distances, previous, paths: new Map([[from, []]]) });
    }
    const { distances, previous, paths } = cache.get(from);
    if (!distances.has(to)) return null;
    if (!paths.has(to)) {
      const arcs = [];
      for (let node = to; node !== from;) {
        const arc = previous.get(node);
        arcs.push(arc);
        node = arc.from;
      }
      paths.set(to, arcs.reverse());
    }
    return paths.get(to);
  };
}

// Seconds and kopecks are integers throughout feasibility checks.
const travelSeconds = (km, kmh) => Math.max(1, Math.ceil(km * 3600 / kmh - 1e-9));

const routeCost = (seconds, hourlyRate) => Math.ceil(seconds * Math.round(hourlyRate * 100) / 3600);

function measure(vehicle, jobs, depot, transfer, includeLegs = false) {
  let position = depot;
  let seconds = 0;
  let deadKm = 0;
  const legs = [];
  const finish = new Map();

  function move(type, arc, job) {
    const start = seconds;
    seconds += travelSeconds(arc.edge.km, job ? vehicle.workKmh : vehicle.driveKmh);
    if (job) finish.set(job.task.id, seconds);
    else deadKm += arc.edge.km;
    if (includeLegs) {
      const leg = { type, edgeId: arc.edge.id, from: arc.from, to: arc.to,
        startMin: start / 60, endMin: seconds / 60, name: job?.task.name || arc.edge.name };
      if (job) leg.taskId = job.task.id;
      legs.push(leg);
    }
    position = arc.to;
  }

  function driveTo(destination) {
    const arcs = transfer(position, destination);
    if (!arcs) return false;
    for (const arc of arcs) move('drive', arc);
    return true;
  }

  for (const job of jobs) {
    if (!driveTo(job.from)) return null;
    move('work', job, job);
  }
  if (!driveTo(depot)) return null;
  const cents = routeCost(seconds, vehicle.rate);
  return { jobs, vehicle, seconds, cents, deadKm, finish, legs };
}

function better(left, right) {
  if (!right) return true;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i];
  }
  return false;
}

function protectsDeadlines(previous, candidate, priority) {
  for (const job of previous.jobs) {
    const earlier = previous.finish.get(job.task.id);
    const later = candidate.finish.get(job.task.id);
    const due = job.task.targetMin * 60;
    // Keep existing on-time work on time. Lower classes may not increase
    // lateness of a higher-class pass that is already overdue.
    if (earlier <= due && later > due) return false;
    if (job.task.priority < priority && later > Math.max(earlier, due)) return false;
  }
  return true;
}

// Move one existing pass, then let the insertion search try the unassigned pass.
function* relocatedOrders(jobs) {
  for (let from = 0; from < jobs.length; from++) {
    for (let to = 0; to < jobs.length; to++) {
      // Moving either neighbour towards the other gives the same adjacent swap.
      if (from === to || to === from - 1) continue;
      const order = jobs.slice();
      const [job] = order.splice(from, 1);
      order.splice(to, 0, job);
      yield order;
    }
  }
}

function reasonForOmission(job, routes, onlyTask, shiftSeconds, budget, scheduleReason, depot, transfer) {
  let timeCanFit = false;
  for (const route of routes) {
    // For a sole task the entire depot trip is known. Otherwise just the service
    // time is a safe lower bound, including when work is faster than deadheading.
    const seconds = onlyTask
      ? measure(route.vehicle, [job], depot, transfer).seconds
      : travelSeconds(job.edge.km, route.vehicle.workKmh);
    if (seconds > shiftSeconds) continue;
    timeCanFit = true;
    if (routeCost(seconds, route.vehicle.rate) <= budget) return scheduleReason;
  }
  return timeCanFit
    ? 'Недостаточно бюджета смены даже для одного этого прохода на подходящей по времени машине'
    : 'Недостаточно времени смены даже для одного этого прохода';
}

function coverageByPriority(result, tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const score = Array(8).fill(0);
  for (const route of result.routes) {
    for (const leg of route.legs) {
      if (leg.type !== 'work') continue;
      const task = byId.get(leg.taskId);
      const offset = (task.priority - 1) * 2;
      // Lower is better. Within each class, protect on-time jobs first.
      if (leg.endMin * 60 <= task.targetMin * 60 + 1e-8) score[offset]--;
      score[offset + 1]--;
    }
  }
  return score;
}

// City shifts grow feasible routes at their ends. This preserves all previously
// assigned completion times and avoids an all-pairs matrix across the city.
function cityGraph(network, closed) {
  const outgoing = new Map(Object.keys(network.nodes).map(id => [id, []]));
  const incoming = new Map(Object.keys(network.nodes).map(id => [id, []]));
  const add = (edge, from, to) => {
    const arc = { edge, from, to };
    outgoing.get(from).push(arc);
    incoming.get(to).push(arc);
  };
  for (const edge of network.edges) {
    if (edge.routable === false || closed.has(String(edge.id))) continue;
    const from = String(edge.from), to = String(edge.to);
    if (!outgoing.has(from) || !incoming.has(to) || !(edge.km > 0)) {
      throw new Error('Некорректная геометрия дорожного графа');
    }
    add(edge, from, to);
    if (!edge.oneway) add(edge, to, from);
  }
  return { outgoing, incoming };
}

// Binary min-heap. Ignore obsolete entries after finding a shorter distance.
function shortestTree(adjacency, start, reverse, visit) {
  const heap = [[0, start]];
  const distances = new Map([[start, 0]]);
  const previous = new Map();
  while (heap.length) {
    const [distance, node] = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
        if (heap[child][0] >= last[0]) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    if (distance !== distances.get(node)) continue;
    if (visit && visit(node, distance, previous) === false) break;
    for (const arc of adjacency.get(node)) {
      const next = reverse ? arc.from : arc.to;
      const km = distance + arc.edge.km;
      if (km >= (distances.get(next) ?? Infinity)) continue;
      distances.set(next, km);
      previous.set(next, arc);
      let i = heap.length;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent][0] <= km) break;
        heap[i] = heap[parent];
        i = parent;
      }
      heap[i] = [km, next];
    }
  }
  return { distances, previous };
}

function cityPath(previous, node, reverse) {
  const path = [];
  while (previous.has(node)) {
    const arc = previous.get(node);
    path.push(arc);
    node = reverse ? arc.to : arc.from;
  }
  return reverse ? path : path.reverse();
}

function cityLeg(route, arc, task) {
  const start = route.elapsed;
  const seconds = travelSeconds(arc.edge.km, task ? route.vehicle.workKmh : route.vehicle.driveKmh);
  route.elapsed += seconds;
  if (!task) route.deadKm += arc.edge.km;
  route.legs.push({ type: task ? 'work' : 'drive', edgeId: arc.edge.id,
    from: arc.from, to: arc.to, startMin: start / 60, endMin: route.elapsed / 60,
    name: task?.name || arc.edge.name, ...(task ? { taskId: task.id } : {}) });
}

function planCity(network, tasks, vehicles, input) {
  const depot = String(network.depot);
  const closed = new Set(input.closed.map(String));
  const { outgoing, incoming } = cityGraph(network, closed);
  const outward = shortestTree(outgoing, depot, false).distances;
  const home = shortestTree(incoming, depot, true);
  const edges = new Map(network.edges.map(edge => [String(edge.id), edge]));
  const budget = Math.round(input.budget * 100);
  const limit = input.shiftMin * 60;
  const parallel = input.strategy === 'parallel';
  const routes = vehicles.map(vehicle => {
    if (!(vehicle.driveKmh > 0 && vehicle.workKmh > 0 && vehicle.rate >= 0)) {
      throw new Error('Некорректный тариф или скорость машины');
    }
    return { vehicle, position: depot, elapsed: 0, cents: 0, finish: 0, deadKm: 0, legs: [] };
  });
  const groups = Array.from({length: 4}, () => new Map());
  const unassigned = [];
  for (const task of tasks) {
    if (![1,2,3,4].includes(task.priority) || !Number.isFinite(task.targetMin) || task.targetMin < 0) {
      throw new Error('Некорректный приоритет или срок задания');
    }
    const edge = edges.get(String(task.edgeId));
    if (!edge) throw new Error('У задания отсутствует участок дороги');
    const from = String(task.reverse ? edge.to : edge.from);
    const to = String(task.reverse ? edge.from : edge.to);
    let reason;
    if (closed.has(String(edge.id))) reason = 'Дорога перекрыта';
    else if (edge.routable === false) reason = 'Проезд техники ограничен';
    else if (edge.oneway && task.reverse) reason = 'Запрещённое направление прохода';
    else if (!vehicles.length) reason = 'На смену не выбрана техника';
    else if (!outward.has(from) || !home.distances.has(to)) reason = 'Нет проезда с базы или обратного пути';
    if (reason) unassigned.push({ taskId: task.id, reason });
    else {
      const group = groups[task.priority - 1];
      if (!group.has(from)) group.set(from, new Map());
      group.get(from).set(task.id, { from, to, edge, task });
    }
  }
  let totalCents = 0, onTime = 0, urgentOnTime = 0;
  const returnTimes = new Map();
  function returnSeconds(node, speed) {
    if (!returnTimes.has(speed)) returnTimes.set(speed, new Map([[depot, 0]]));
    const cached = returnTimes.get(speed), missing = [];
    while (!cached.has(node)) {
      const arc = home.previous.get(node);
      missing.push(arc);
      node = arc.to;
    }
    let seconds = cached.get(node);
    for (const arc of missing.reverse()) {
      seconds += travelSeconds(arc.edge.km, speed);
      cached.set(arc.from, seconds);
    }
    return seconds;
  }
  for (const group of groups) {
    while (group.size) {
      let best;
      for (const route of routes) {
        const vehicle = route.vehicle;
        const availableCents = budget - totalCents + route.cents;
        const otherFinish = parallel ? routes.reduce((max, r) => r === route ? max : Math.max(max, r.finish), 0) : 0;
        let feasible = 0;
        shortestTree(outgoing, route.position, false, (node, distance, previous) => {
          // Ignoring per-edge rounding and the return gives a safe lower bound.
          const earliest = route.elapsed + Math.floor(distance * 3600 / vehicle.driveKmh);
          if (earliest >= limit || routeCost(earliest, vehicle.rate) > availableCents) return false;
          if (!group.has(node)) return;
          const transfer = cityPath(previous, node, false);
          const drive = transfer.reduce((sum, arc) => sum + travelSeconds(arc.edge.km, vehicle.driveKmh), 0);
          for (const job of group.get(node).values()) {
            const completion = route.elapsed + drive + travelSeconds(job.edge.km, vehicle.workKmh);
            const finish = completion + returnSeconds(job.to, vehicle.driveKmh);
            const cents = routeCost(finish, vehicle.rate);
            if (finish > limit || cents > availableCents) continue;
            feasible++;
            const late = Math.max(0, completion - job.task.targetMin * 60);
            const extraCost = cents - route.cents;
            const deadDelta = distance + home.distances.get(job.to) - home.distances.get(route.position);
            const score = parallel
              ? [late, job.task.targetMin, Math.max(otherFinish, finish), extraCost, deadDelta, completion]
              : [late, job.task.targetMin, extraCost, completion, deadDelta];
            if (better(score, best?.score)) best = { job, route, transfer, finish, completion, cents, score };
          }
          // Keep graph searches local when a priority class has many nearby options.
          return feasible < 24;
        });
      }
      if (!best) {
        for (const jobs of group.values()) for (const job of jobs.values()) {
          unassigned.push({ taskId: job.task.id, reason: 'Не найдено продолжение маршрута в пределах бюджета и времени смены с возвратом на базу' });
        }
        break;
      }
      const { job, route, transfer, finish, completion, cents } = best;
      for (const arc of transfer) cityLeg(route, arc);
      cityLeg(route, job, job.task);
      route.position = job.to;
      totalCents += cents - route.cents;
      route.cents = cents;
      route.finish = finish;
      if (completion <= job.task.targetMin * 60) {
        onTime++;
        if (job.task.priority === 1) urgentOnTime++;
      }
      const jobs = group.get(job.from);
      jobs.delete(job.task.id);
      if (!jobs.size) group.delete(job.from);
    }
  }
  const scheduled = routes.map(route => {
    for (const arc of cityPath(home.previous, route.position, true)) cityLeg(route, arc);
    return { vehicleId: route.vehicle.id, name: route.vehicle.name, minutes: route.elapsed / 60,
      cost: route.cents / 100, deadKm: route.deadKm, legs: route.legs };
  });
  return { routes: scheduled, unassigned, summary: { total: tasks.length, assigned: tasks.length - unassigned.length,
    cost: totalCents / 100, deadKm: routes.reduce((sum, r) => sum + r.deadKm, 0),
    onTime, urgentOnTime, urgentTotal: tasks.filter(task => task.priority === 1).length } };
}

function cityCoverage(network, tasks, result) {
  const omitted = new Set(result.unassigned.map(item => item.taskId));
  const counts = new Map();
  for (const task of tasks) {
    const key = String(task.edgeId);
    if (!counts.has(key)) counts.set(key, { required: 0, assigned: 0 });
    const count = counts.get(key);
    count.required++;
    if (!omitted.has(task.id)) count.assigned++;
  }
  const coverage = { networkKm: 0, requiredNetworkKm: 0, fullyAssignedKm: 0, partiallyAssignedKm: 0,
    requiredTasks: tasks.length, assignedTasks: result.summary.assigned };
  for (const edge of network.edges) {
    coverage.networkKm += edge.km;
    const count = counts.get(String(edge.id));
    if (!count) continue;
    coverage.requiredNetworkKm += edge.km;
    if (count.assigned === count.required) coverage.fullyAssignedKm += edge.km;
    else if (count.assigned > 0) coverage.partiallyAssignedKm += edge.km;
  }
  return coverage;
}

export function plan(network, tasks, fleet, input) {
  const depot = String(network.depot);
  if (!Object.hasOwn(network.nodes, depot)) throw new Error('База отсутствует в дорожном графе');
  const closed = new Set(input.closed.map(String));
  const selected = new Set(input.vehicleIds.map(String));
  const vehicles = fleet.filter(vehicle => selected.has(String(vehicle.id)));
  if (network.scope === 'city' || tasks.length > 64) {
    let result = planCity(network, tasks, vehicles, input);
    if (input.strategy === 'parallel' && vehicles.length > 1 && result.summary.onTime < tasks.length) {
      const alternative = planCity(network, tasks, vehicles, { ...input, strategy: 'economy' });
      if (better(coverageByPriority(alternative, tasks), coverageByPriority(result, tasks))) result = alternative;
    }
    result.coverage = cityCoverage(network, tasks, result);
    return result;
  }
  const parallel = input.strategy === 'parallel' && vehicles.length > 1;
  const transfer = buildTransfers(network, closed);
  const edges = new Map(network.edges.map(edge => [String(edge.id), edge]));
  const budget = Math.round(input.budget * 100);
  const shiftSeconds = input.shiftMin * 60;
  const unassigned = [];
  const pending = [];
  const routes = vehicles.map(vehicle => {
    if (!(vehicle.workKmh > 0 && vehicle.driveKmh > 0 && vehicle.rate >= 0)) {
      throw new Error('Некорректный тариф или скорость машины');
    }
    return measure(vehicle, [], depot, transfer);
  });

  for (const task of tasks) {
    if (![1, 2, 3, 4].includes(task.priority) || !Number.isFinite(task.targetMin) || task.targetMin < 0) {
      throw new Error('Некорректный приоритет или срок задания');
    }
    const edge = edges.get(String(task.edgeId));
    if (!edge) throw new Error('У задания отсутствует участок дороги');
    const from = String(task.reverse ? edge.to : edge.from);
    const to = String(task.reverse ? edge.from : edge.to);
    let reason;
    if (closed.has(String(edge.id))) reason = 'Дорога перекрыта';
    else if (edge.oneway && task.reverse) reason = 'Запрещённое направление прохода';
    else if (!vehicles.length) reason = 'На смену не выбрана техника';
    else if (!transfer(depot, from) || !transfer(to, depot)) reason = 'Нет проезда с базы или обратного пути';
    if (reason) unassigned.push({ taskId: task.id, reason });
    else pending.push({ edge, from, to, task });
  }

  // Maximum additional candidate schedules evaluated in this strategy.
  let remainingRepairs = 3000;
  let totalCents = 0;
  for (const priority of [1, 2, 3, 4]) {
    const group = pending.filter(job => job.task.priority === priority);
    while (group.length) {
      let best;
      const reasons = new Map();
      function search(repair) {
        for (const [jobIndex, job] of group.entries()) {
          let fitsShift = false;
          let fitsBudget = false;
          for (const [routeIndex, route] of routes.entries()) {
            const otherFinish = parallel
              ? routes.reduce((max, other) => other === route ? max : Math.max(max, other.seconds), 0)
              : 0;
            const orders = repair ? relocatedOrders(route.jobs) : [route.jobs];
            for (const order of orders) {
              for (let i = 0; i <= order.length; i++) {
                if (repair) {
                  if (!remainingRepairs) return;
                  remainingRepairs--;
                }
                const jobs = order.slice();
                jobs.splice(i, 0, job);
                const candidate = measure(route.vehicle, jobs, depot, transfer);
                if (!candidate || candidate.seconds > shiftSeconds) continue;
                fitsShift = true;
                const extraCost = candidate.cents - route.cents;
                if (totalCents + extraCost > budget) continue;
                fitsBudget = true;
                if (!protectsDeadlines(route, candidate, priority)) continue;
                const completion = candidate.finish.get(job.task.id);
                const lateness = Math.max(0, completion - job.task.targetMin * 60);
                const score = parallel
                  ? [lateness, job.task.targetMin, Math.max(otherFinish, candidate.seconds),
                    extraCost, candidate.deadKm - route.deadKm, completion]
                  : [lateness, job.task.targetMin, extraCost, completion, candidate.seconds];
                if (better(score, best?.score)) best = { jobIndex, routeIndex, candidate, extraCost, score };
              }
            }
          }
          if (!repair) {
            const constraint = !fitsShift ? 'времени смены с учётом возврата'
              : !fitsBudget ? 'бюджета смены' : 'сроков ранее назначенных проходов';
            reasons.set(job.task.id, 'Не найдено назначение при текущем расписании с учётом ' + constraint);
          }
        }
      }
      search(false);
      if (!best && remainingRepairs) search(true);
      if (!best) {
        for (const job of group) {
          const reason = reasonForOmission(job, routes, tasks.length === 1, shiftSeconds,
            budget, reasons.get(job.task.id), depot, transfer);
          unassigned.push({ taskId: job.task.id, reason });
        }
        break;
      }
      group.splice(best.jobIndex, 1);
      routes[best.routeIndex] = best.candidate;
      totalCents += best.extraCost;
    }
  }
  let onTime = 0;
  let urgentOnTime = 0;
  let deadKm = 0;
  const scheduled = routes.map(route => {
    const final = measure(route.vehicle, route.jobs, depot, transfer, true);
    for (const { task } of final.jobs) {
      if (final.finish.get(task.id) > task.targetMin * 60) continue;
      onTime++;
      if (task.priority === 1) urgentOnTime++;
    }
    deadKm += final.deadKm;
    return { vehicleId: route.vehicle.id, name: route.vehicle.name, minutes: final.seconds / 60,
      cost: final.cents / 100, deadKm: final.deadKm, legs: final.legs };
  });
  const result = { routes: scheduled, unassigned, summary: {
    cost: totalCents / 100, deadKm, assigned: tasks.length - unassigned.length, total: tasks.length,
    onTime, urgentTotal: tasks.filter(task => task.priority === 1).length, urgentOnTime,
  } };
  // An extra departure can exhaust a tight budget. Keep the economical
  // assignment when it covers more jobs by class or meets more of their targets.
  if (parallel && onTime < tasks.length) {
    const alternative = plan(network, tasks, fleet, { ...input, strategy: 'economy' });
    if (better(coverageByPriority(alternative, tasks), coverageByPriority(result, tasks))) return alternative;
  }
  return result;
}
