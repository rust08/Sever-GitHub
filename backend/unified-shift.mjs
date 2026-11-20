import {calculateHaul} from './haul.mjs';

export function validateUnifiedPlan(plan){
  const start=Date.parse(plan.windowStart), end=Date.parse(plan.windowEnd);
  const fleet=new Set(plan.vehicleIds);
  const timelines=new Map();
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw Error('Некорректное окно смены');
  for(const slot of plan.reservations){
    const machine=slot.resourceType==='machine';
    if(machine?!fleet.has(slot.resourceId):slot.resourceType!=='unload_post'||slot.resourceId!==plan.siteNode)
      throw Error('Неизвестный ресурс смены');
    const from=Date.parse(slot.start),to=Date.parse(slot.end);
    if(!(start<=from && from<to && to<=end))throw Error('Бронь выходит за окно смены');
    const key=JSON.stringify([slot.resourceType,slot.resourceId]);
    if(!timelines.has(key))timelines.set(key,[]);
    timelines.get(key).push([from,to]);
  }
  for(const slots of timelines.values()){
    slots.sort((a,b)=>a[0]-b[0]);
    for(let i=1;i<slots.length;i++)if(slots[i][0]<slots[i-1][1])throw Error('Пересечение брони ресурса');
  }
  const charges=[...plan.clearing.routes.map(route=>Math.round(route.cost*100)),...plan.haul.trips.map(trip=>trip.cents)];
  const spent=charges.reduce((sum,cents)=>sum+cents,0);
  if(charges.some(c=>!Number.isSafeInteger(c)||c<0)||!Number.isSafeInteger(plan.budgetCents)||spent>plan.budgetCents||
    spent!==plan.spentCents||plan.remainingCents!==plan.budgetCents-spent)throw Error('Нарушен баланс бюджета смены');
}

export function combineShift(data,input,clearing,options,plowClosed,episode=null){
  const budgetCents=Math.round(input.budget*100);
  const plowCents=Math.round(clearing.summary.cost*100);
  const readyAt=new Map();
  const atOtherDepot=new Set();
  const shiftStart=Date.parse(input.date+'T'+input.start+':00+12:00');
  const instant=minutes=>new Date(shiftStart+Math.round(minutes*60000)).toISOString();
  const reservations=[];
  function reserve(resourceType,resourceId,kind,start,end,detail){
    if(start===end)return;
    reservations.push({resourceType,resourceId,kind,start:instant(start),end:instant(end),...detail});
  }
  for(const route of clearing.routes){
    for(const leg of route.legs)reserve('machine',route.vehicleId,leg.type==='work'?'plow':'drive',leg.startMin,leg.endMin,{edgeId:leg.edgeId,taskId:leg.taskId});
    if(!route.legs.length)continue;
    if(String(data.network.depot)===String(options.loadNode))readyAt.set(route.vehicleId,Math.ceil(route.minutes));
    else atOtherDepot.add(route.vehicleId);
  }
  const haulInput={...input,budget:(budgetCents-plowCents)/100,vehicleIds:input.vehicleIds.filter(id=>!atOtherDepot.has(id))};
  let haul;
  if(episode){
    const {minute,previous,addedM3}=episode;
    const locked=previous.trips.filter(trip=>trip.start<=minute);
    const volume=locked.reduce((total,t)=>total+t.amount,0);
    const cents=locked.reduce((total,t)=>total+t.cents,0);
    haulInput.budget=(budgetCents-plowCents-cents)/100;
    for(const id of haulInput.vehicleIds)readyAt.set(id,Math.max(minute,readyAt.get(id)??0));
    let postFree=options.siteBusyUntil;
    for(const trip of locked){
      readyAt.set(trip.truckId,Math.max(readyAt.get(trip.truckId)??0,trip.back));
      readyAt.set(previous.loaderId,Math.max(readyAt.get(previous.loaderId)??0,trip.depart));
      postFree=Math.max(postFree,trip.finish);
    }
    const total=previous.delivered+previous.remaining+addedM3;
    haul=calculateHaul(haulInput,input.fleet??data.fleet,{...options,volume:total-volume,
      siteCapacity:options.siteCapacity-volume,siteBusyUntil:postFree},data.network,readyAt);
    // Keep path references in already-started trips stable across revisions.
    const offset=previous.routeSets.length;
    for(const trip of haul.trips)if(trip.routeIndex!==undefined)trip.routeIndex+=offset;
    haul.routeSets=[...previous.routeSets,...haul.routeSets];
    haul.trips=[...locked,...haul.trips];
    haul.cost=(Math.round(haul.cost*100)+cents)/100;
    haul.delivered+=volume;
    haul.totalCargoKg=haul.delivered*options.densityKgM3;
  }else{
    haul=calculateHaul(haulInput,input.fleet??data.fleet,options,data.network,readyAt);
  }
  if(options.siteBusyUntil>0)reserve('unload_post',options.siteNode,'prior_booking',0,Math.min(options.siteBusyUntil,input.shiftMin),{});
  for(const [index,t] of haul.trips.entries()){
    const detail={trip:index+1};
    reserve('machine',haul.loaderId,'load',t.start,t.depart,detail);
    for(const [kind,start,end] of [['loading',t.start,t.depart],['loaded_drive',t.depart,t.arrive],
      ['wait',t.arrive,t.unload],['unload',t.unload,t.finish],['return',t.finish,t.back]]){
      reserve('machine',t.truckId,kind,start,end,detail);
    }
    reserve('unload_post',options.siteNode,'unload',t.unload,t.finish,detail);
  }
  const spentCents=plowCents+Math.round(haul.cost*100);
  const result={mode:'simulation',policy:'clearing_first_v1',networkVersion:data.network.version,
    windowStart:instant(0),windowEnd:instant(input.shiftMin),vehicleIds:input.vehicleIds,siteNode:options.siteNode,
    budgetCents,spentCents,remainingCents:budgetCents-spentCents,plowClosed,unavailableAtLoadNode:[...atOtherDepot],
    clearing,haul,reservations};
  validateUnifiedPlan(result);
  return result;
}
