// Project service targets, measured from the start of the shift.
export const policy = [
  {level:1,title:'Экстренный доступ',rule:'Диспетчер подтвердил срочный вызов на этом участке. Назначается только указанному направлению прохода.',targetMin:45},
  {level:2,title:'Транспортный каркас',rule:'По участку проходит автобусный маршрут по данным OSM либо это магистраль класса trunk или primary, включая их съезды.',targetMin:90},
  {level:3,title:'Районные связи',rule:'Дороги классов secondary и tertiary, включая съезды, и городские связующие дороги класса unclassified.',targetMin:150},
  {level:4,title:'Местный доступ',rule:'Остальные включённые в смену участки, в том числе жилые улицы.',targetMin:240}
];
export function priorityFor(edge, incident) {
  let level = 4, reason = 'Местный проезд · класс OSM ' + edge.highway;
  if (incident) {
    level = 1; reason = 'Срочный вызов, заданный диспетчером в сценарии этой смены';
  } else if (edge.busRoutes?.length) {
    level = 2; reason = 'Автобусные маршруты OSM · ' + edge.busRoutes.join(', ');
  } else if (/^(trunk|primary)(_link)?$/.test(edge.highway)) {
    level = 2; reason = 'Магистраль · класс OSM ' + edge.highway;
  } else if (/^(secondary|tertiary)(_link)?$|^unclassified$/.test(edge.highway)) {
    level = 3; reason = 'Районная связь · класс OSM ' + edge.highway;
  }
  return {priority:level,reason,targetMin:policy[level-1].targetMin};
}
export const fleetSeed = [
  {id:'kdm-01',name:'КДМ-01',rate:4600,workKmh:9,driveKmh:22},
  {id:'kdm-02',name:'КДМ-02',rate:4200,workKmh:8,driveKmh:20},
  {id:'plow-03',name:'Отвал-03',rate:3800,workKmh:7,driveKmh:18}
];
// A confirmed request can add a service pass to a shift on an accessible
// transit-only road. The caller keeps only the directions actually requested.
export function passesForEdge(edge, forced = false) {
  const required = edge.serviceRequired ?? !['service', 'track'].includes(edge.highway);
  if (edge.routable === false || (!required && !forced)) return [];
  const name = edge.name || ('Участок ' + edge.id);
  const pass = { id: 'pass:' + edge.id + ':f', edgeId: edge.id, name,
    reverse: false, ...priorityFor(edge, forced) };
  if (edge.oneway) return [pass];
  return [pass, { ...pass, id: 'pass:' + edge.id + ':r', name: name + ' · обратно', reverse: true }];
}

export function makePasses(network) {
  if (network.scope === 'city') return network.edges.flatMap(edge => passesForEdge(edge));

  // Sample across road names before allocating extra passes on the same street.
  const groups = new Map();
  const sorted = [...network.edges].filter(e=>e.name && e.km>0.05).sort((a,b)=>b.km-a.km || String(a.id).localeCompare(String(b.id)));
  for (const edge of sorted) {
    if (!groups.has(edge.name)) groups.set(edge.name, []);
    groups.get(edge.name).push(edge);
  }
  const sample = [];
  for(let i=0;sample.length<18 && sample.length<sorted.length;i++) {
    for(const group of groups.values()) if(group[i] && sample.length<18) sample.push(group[i]);
  }
  return sample.flatMap((e,i)=>{
    const task = {id:'road-'+(i+1),edgeId:e.id,name:e.name,reverse:false,...priorityFor(e,false)};
    return i<3 && !e.oneway ? [task,{...task,id:task.id+'-r',name:e.name+' · обратно',reverse:true}] : [task];
  });
}
