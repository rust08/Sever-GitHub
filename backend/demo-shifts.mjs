import {randomUUID} from 'node:crypto';
import {plan as routePasses} from './planner.mjs';
import {api} from './service.mjs';
import {combineShift} from './unified-shift.mjs';

const presets={normal:'Обычная смена',heavy:'Сильный снегопад'};
class DemoError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
function requireDemo(ok,status,message){if(!ok)throw new DemoError(status,message);}

function scenarioInput(network,scenario){
  const loadNode=String(network.depot);
  const edge=network.edges.find(e=>e.routable!==false && !e.oneway &&
    String(e.from)!==String(e.to) && [String(e.from),String(e.to)].includes(loadNode));
  requireDemo(edge,422,'У базы нет двусторонней дороги для демонстрационного рейса');
  const siteNode=String(String(edge.from)===loadNode?edge.to:edge.from);
  const vehicle={rate:600,workKmh:10,driveKmh:25,type:'Учебная машина'};
  const fleet=[{...vehicle,id:'p',name:'КДМ',operations:['patrol_plow']},
    {...vehicle,id:'l',name:'Погрузчик',operations:['snow_load']},
    {...vehicle,id:'t',name:'Самосвал',operations:['snow_haul','snow_unload'],bodyM3:5,payloadKg:3000}];
  const shift={date:'2026-11-20',start:'08:00',shiftMin:60,budget:5000,closed:[],fleet,vehicleIds:fleet.map(v=>v.id)};
  const options={travelMode:'network',fleetMode:'shift',loadNode,siteNode,sitePermitted:true,
    volume:scenario==='heavy'?40:10,siteCapacity:50,loadRate:60,densityKgM3:500,unloadMin:3,siteBusyUntil:0};
  return {shift,options};
}

// The presets have one dedicated plow. It starts a new route only from its depot.
function addRepeatPasses(data,input,previous,event,revision){
  const clearing=previous.clearing;
  if(!event.repeatPassIds?.length)return clearing;
  const byId=new Map(data.tasks.map(task=>[task.id,task]));
  const vehicle=input.shift.fleet.find(v=>v.operations.includes('patrol_plow'));
  const route=clearing.routes.find(r=>r.vehicleId===vehicle.id);
  const start=Math.max(event.minute,Math.ceil(route.minutes));
  const tasks=event.repeatPassIds.map(id=>{
    const original=byId.get(id);
    requireDemo(original,422,'Участок или направление отсутствует в каталоге');
    return {...original,id:'episode-'+revision+'-'+id,targetMin:Math.max(0,event.minute+original.targetMin-start)};
  });
  const lockedCents=previous.haul.trips.filter(t=>t.start<=event.minute).reduce((sum,t)=>sum+t.cents,0);
  const budget=(previous.budgetCents-lockedCents-Math.round(clearing.summary.cost*100))/100;
  const window=input.shift.shiftMin-start;
  const result=window>0 && budget>0?routePasses(data.network,tasks,[vehicle],{...input.shift,closed:previous.plowClosed,
    shiftMin:window,budget,vehicleIds:[vehicle.id]}):null;
  const extra=result?.routes[0];
  if(extra?.legs.length){
    for(const leg of extra.legs)route.legs.push({...leg,startMin:leg.startMin+start,endMin:leg.endMin+start});
    route.minutes=start+extra.minutes;
    route.deadKm+=extra.deadKm;
    route.cost=(Math.round(route.cost*100)+Math.round(extra.cost*100))/100;
    clearing.summary.cost=(Math.round(clearing.summary.cost*100)+Math.round(extra.cost*100))/100;
    clearing.summary.deadKm+=extra.deadKm;
  }
  clearing.summary.total+=tasks.length;
  clearing.summary.assigned+=result?.summary.assigned??0;
  clearing.summary.onTime+=result?.summary.onTime??0;
  const omitted=result?.unassigned??tasks.map(t=>({taskId:t.id,reason:'Нет свободного времени или бюджета после закреплённых работ'}));
  clearing.unassigned.push(...omitted);
  return clearing;
}

export async function demoShiftResponse(request,db,data){
  const url=new URL(request.url);
  const match=/^\/api\/demo-shifts(?:\/([0-9a-f-]{36})(?:\/(snowfall|export))?)?$/.exec(url.pathname);
  const json=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
  try{
    requireDemo(match,404,'Путь не найден');
    const [,id,action]=match;
    if(request.method==='GET' && !id)return json({mode:'simulation',scenarios:presets});
    const latest=id && db.prepare('SELECT * FROM demo_shift_revisions WHERE shift_id=? ORDER BY revision DESC LIMIT 1').get(id);
    if(id)requireDemo(latest,404,'Учебная смена не найдена');
    if(request.method==='GET' && action!=='snowfall'){
      const rev=url.searchParams.get('revision');
      const row=rev===null?latest:db.prepare('SELECT * FROM demo_shift_revisions WHERE shift_id=? AND revision=?').get(id,Number(rev));
      requireDemo(row,404,'Редакция отсутствует');
      const events=db.prepare('SELECT revision,event_json FROM demo_shift_revisions WHERE shift_id=? AND revision<=? ORDER BY revision').all(id,row.revision)
        .map(entry=>({revision:entry.revision,...JSON.parse(entry.event_json)}));
      const report={id,revision:row.revision,scenario:row.scenario,title:presets[row.scenario],simulation:true,
        assumptions:['Учебная площадка и тарифы','Начало рейса моделируется по расписанию','Исходные маршруты КДМ закреплены до возврата. Дополнительные проходы начинаются с базы; ожидание на базе без тарифа.'],
        events,input:JSON.parse(row.input_json),plan:JSON.parse(row.plan_json)};
      return json(report,200,action==='export'?{'Content-Disposition':'attachment; filename="snow-shift-'+id+'-v'+row.revision+'.json"'}:{});
    }
    requireDemo(request.method==='POST' && (!id||action==='snowfall'),405,'Метод недоступен');
    requireDemo(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'Требуется JSON');
    const body=await request.json().catch(()=>null);
    requireDemo(body && typeof body==='object' && !Array.isArray(body),400,'Требуется объект JSON');
    let input,scenario,event,plan;
    const shiftId=id??randomUUID();
    const revision=(latest?.revision??0)+1;
    if(!id){
      scenario=body.scenario;
      requireDemo(typeof scenario==='string' && Object.hasOwn(presets,scenario) && Object.keys(body).length===1,400,'Выберите normal или heavy');
      input=scenarioInput(data.network,scenario);
      plan=await api(null,'POST','/api/unified-shifts/preview',input,data);
      event={type:'created'};
    }else{
      const {expectedRevision,minute,addedM3}=body;
      requireDemo(Number.isSafeInteger(expectedRevision)&&expectedRevision>=1 && Number.isSafeInteger(minute)&&minute>=0 &&
        Number.isSafeInteger(addedM3)&&addedM3>0 && Object.keys(body).every(k=>['expectedRevision','minute','addedM3','repeatPassIds'].includes(k)),400,'Укажите редакцию, минуту смены и положительный целый объём снега в м³');
      event={type:'snowfall',minute,addedM3};
      if(body.repeatPassIds!==undefined){
        const ids=body.repeatPassIds;
        requireDemo(Array.isArray(ids) && ids.length<=100 && ids.every(id=>typeof id==='string') && new Set(ids).size===ids.length,400,'Укажите до 100 разных направлений');
        event.repeatPassIds=ids;
      }
      if(expectedRevision!==latest.revision){
        const replay=db.prepare('SELECT event_json FROM demo_shift_revisions WHERE shift_id=? AND revision=?').get(id,expectedRevision+1);
        requireDemo(replay?.event_json===JSON.stringify(event),409,'Редакция изменилась. Обновите смену');
        return json({id,revision:expectedRevision+1});
      }
      scenario=latest.scenario;
      input=JSON.parse(latest.input_json);
      const previous=JSON.parse(latest.plan_json);
      requireDemo(previous.networkVersion===data.network.version,409,'Версия сети изменилась. Создайте новую учебную смену');
      requireDemo(minute<input.shift.shiftMin && minute>(JSON.parse(latest.event_json).minute??-1),422,'Событие должно быть позже предыдущего и до конца смены');
      requireDemo(previous.haul.delivered+previous.haul.remaining+addedM3<=1000000,422,'Общий объём превышает предел сценария');
      const clearing=addRepeatPasses(data,input,previous,event,revision);
      plan=combineShift(data,input.shift,clearing,input.options,previous.plowClosed,
        {minute,previous:previous.haul,addedM3});
    }
    const inserted=db.prepare(`INSERT INTO demo_shift_revisions
      SELECT ?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM demo_shift_revisions WHERE shift_id=?)=?`)
      .run(shiftId,revision,scenario,JSON.stringify(input),JSON.stringify(event),JSON.stringify(plan),shiftId,revision-1);
    requireDemo(inserted.changes===1,409,'Редакция изменилась. Обновите смену');
    return json({id:shiftId,revision},201);
  }catch(error){
    if(error instanceof DemoError)return json({error:error.message},error.status);
    throw error;
  }
}
