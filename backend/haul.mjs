import {haulRoadPaths} from './planner.mjs';
import {resourceReason} from './equipment.mjs';

const sampleHaulFleet=[
  {id:'loader',name:'Учебный погрузчик',operations:['snow_load'],rate:3000},
  {id:'truck1',name:'Учебный самосвал 1',operations:['snow_haul','snow_unload'],rate:2400,bodyM3:10,tareKg:8000,widthM:2.5,maxGradePct:8,payloadKg:5000,driveKmh:20},
  {id:'truck2',name:'Учебный самосвал 2',operations:['snow_haul','snow_unload'],rate:2400,bodyM3:10,tareKg:8000,widthM:2.5,maxGradePct:8,payloadKg:5000,driveKmh:20}
];

function transitRoutes(network,input,options,base,density){
  const rules=options.transitLimits??[];
  if(!Array.isArray(rules) || (rules.length && !base))throw Error('Ограничения применяются в режиме городской сети');
  if(!rules.length)return null;
  const ids=new Set(network.edges.map(e=>String(e.id))),seen=new Set();
  for(const r of rules){
    if(!r || !ids.has(r.edgeId) || seen.has(r.edgeId) || typeof r.source!=='string' || !r.source.trim())
      throw Error('Проверьте участок, источник и повторяющиеся ограничения');
    seen.add(r.edgeId);
    if([r.maxKg,r.widthM,r.gradePct].every(v=>v==null))throw Error('Укажите ограничение участка');
    for(const k of ['maxKg','widthM','gradePct']){
      const v=r[k];if(v!=null && (!Number.isFinite(v)||v<0||(k!=='gradePct' && v===0)))throw Error('Проверьте значение ограничения дороги');
    }
  }
  const cache=new Map([['[]',base]]);
  function path(vehicle,amount,direction){
    const massKnown=vehicle.tareKg!=null && (amount===0 || density!==null);
    const denied=rules.filter(r=>
      (r.maxKg!=null && (!massKnown || vehicle.tareKg+amount*density>r.maxKg)) ||
      (r.widthM!=null && (vehicle.widthM==null || vehicle.widthM>r.widthM)) ||
      (r.gradePct!=null && (vehicle.maxGradePct==null || vehicle.maxGradePct<r.gradePct))
    ).map(r=>r.edgeId);
    const key=JSON.stringify(denied);
    if(!cache.has(key))cache.set(key,haulRoadPaths(network,[...input.closed,...denied],options.loadNode,options.siteNode));
    return cache.get(key)[direction];
  }
  return path;
}

export function calculateHaul(input,shiftFleet,options,network,readyAt=new Map()){
  if(!options || !['sample','shift'].includes(options.fleetMode) || typeof options.sitePermitted!=='boolean')throw Error('Укажите парк и статус учебной площадки');
  const {volume,siteCapacity,loadRate,driveMin,unloadMin,siteBusyUntil}=options;
  const density=options.densityKgM3??null;
  if(density!==null && (!Number.isSafeInteger(density) || density<1 || !Number.isSafeInteger(density*volume)))
    throw Error('Проверьте плотность снега в целых положительных кг/м³');
  const roadMode=options.travelMode==='network';
  if(options.travelMode!==undefined && !['network','manual'].includes(options.travelMode))throw Error('Неизвестный способ расчёта пути');
  const paths=roadMode?haulRoadPaths(network,input.closed,options.loadNode,options.siteNode):null;
  for(const [value,min,max] of [[volume,1,1000000],[siteCapacity,0,1000000],[loadRate,1,6000],[roadMode?1:driveMin,1,1440],[unloadMin,1,1440],[siteBusyUntil,0,1440]]){
    if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Проверьте объёмы, производительность и времена. Используйте целые числа.');
  }
  const restrictedPath=transitRoutes(network,input,options,paths,density);
  const routeSets=[];
  const fleet=options.fleetMode==='sample'?sampleHaulFleet:shiftFleet.filter(v=>input.vehicleIds.includes(v.id)).map(v=>({...v,rate:input.rates?.[v.id]??v.rate}));
  const candidates=fleet.filter(v=>Number.isInteger(v.bodyM3) && v.bodyM3>0 &&
    !resourceReason(v,input,'snow_haul') && !resourceReason(v,input,'snow_unload'));
  const excluded=[];
  const haulers=candidates.filter(v=>{
    if(density===null)return true;
    if(Number.isSafeInteger(v.payloadKg) && v.payloadKg>=density)return true;
    excluded.push({id:v.id,name:v.name,reason:v.payloadKg==null?'Не указана грузоподъёмность':'Грузоподъёмность меньше массы 1 м³ снега'});
    return false;
  });
  const loader=fleet.filter(v=>!resourceReason(v,input,'snow_load'))
    .sort((a,b)=>Number(haulers.includes(a))-Number(haulers.includes(b)) || a.rate-b.rate)[0];
  const trucks=haulers.filter(v=>v.id!==loader?.id).map(vehicle=>({vehicle,ready:readyAt.get(vehicle.id)??0,capacity:density===null?vehicle.bodyM3:Math.min(vehicle.bodyM3,Math.floor(vehicle.payloadKg/density))}));
  const trips=[],budget=Math.round(input.budget*100);
  let delivered=0,spent=0,loaderFree=readyAt.get(loader?.id)??0,siteFree=siteBusyUntil,reason='';
  if(!options.sitePermitted)reason='Для площадки не задан учебный допуск';
  else if(!loader)reason='Нет доступного погрузчика с операцией погрузки';
  else if(!trucks.length && excluded.length)reason='Нет отдельного самосвала с достаточной указанной грузоподъёмностью';
  else if(!trucks.length)reason='Нужен отдельный доступный самосвал с объёмом кузова и операциями вывоза и разгрузки';
  else if(paths && !paths.outward)reason='Нет разрешённого пути от погрузки до площадки';
  else if(paths && !paths.home)reason='Нет разрешённого обратного пути с площадки';
  while(!reason && delivered<volume){
    if(delivered===siteCapacity){reason='Исчерпана вместимость площадки';break;}
    let best=null,anyTime=false,anyPath=false;
    for(const truck of trucks){
      const start=Math.max(loaderFree,truck.ready);
      const home=restrictedPath?restrictedPath(truck.vehicle,0,'home'):paths?.home;
      if(roadMode && !home)continue;
      const homeMin=home?Math.ceil(home.km*60/truck.vehicle.driveKmh):driveMin;
      function candidate(amount){
        const outward=restrictedPath?restrictedPath(truck.vehicle,amount,'outward'):paths?.outward;
        if(roadMode && !outward)return null;
        anyPath=true;
        const outwardMin=outward?Math.ceil(outward.km*60/truck.vehicle.driveKmh):driveMin;
        const depart=start+Math.ceil(amount*60/loadRate),arrive=depart+outwardMin;
        const unload=Math.max(arrive,siteFree),finish=unload+unloadMin,back=finish+homeMin;
        const cents=Math.ceil(((depart-start)*Math.round(loader.rate*100)+(back-start)*Math.round(truck.vehicle.rate*100))/60);
        return {amount,start,depart,arrive,unload,finish,back,cents,outward,home};
      }
      // Duration and cost never decrease as load size grows. Find the largest feasible integer load.
      let lo=1,hi=Math.min(volume-delivered,siteCapacity-delivered,truck.capacity),trip=null;
      while(lo<=hi){
        const mid=Math.floor((lo+hi)/2),c=candidate(mid);
        if(!c){hi=mid-1;continue;}
        if(c.back<=input.shiftMin)anyTime=true;
        if(c.back<=input.shiftMin && spent+c.cents<=budget){trip=c;lo=mid+1;}
        else hi=mid-1;
      }
      if(trip && (!best || trip.start<best.trip.start || (trip.start===best.trip.start && trip.cents/trip.amount<best.trip.cents/best.trip.amount)))best={truck,trip};
    }
    if(!best){reason=!anyPath?'Нет пути туда и обратно с учётом ограничений и известных параметров машин':anyTime?'Недостаточно бюджета на следующий рейс':'Недостаточно времени на рейс с возвратом';break;}
    const {truck,trip}=best;
    loaderFree=trip.depart;siteFree=trip.finish;truck.ready=trip.back;delivered+=trip.amount;spent+=trip.cents;
    const {outward,home,...timing}=trip;
    let routeIndex;
    if(restrictedPath){
      routeIndex=routeSets.findIndex(r=>r.outward===outward && r.home===home);
      if(routeIndex<0){routeIndex=routeSets.length;routeSets.push({outward,home});}
    }
    trips.push({...timing,routeIndex,cargoKg:density===null?null:trip.amount*density,truck:truck.vehicle.name,truckId:truck.vehicle.id,wait:trip.unload-trip.arrive});
  }
  return {mode:'simulation',fleetMode:options.fleetMode,densityKgM3:density,excluded,totalCargoKg:density===null?null:density*delivered,loader:loader?.name,loaderId:loader?.id,delivered,remaining:volume-delivered,cost:spent/100,reason,trips,paths:restrictedPath?(routeSets[0]??null):paths,routeSets};
}