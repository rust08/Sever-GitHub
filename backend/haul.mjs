import {resourceReason} from './equipment.mjs';

const sampleHaulFleet=[
  {id:'loader',name:'Учебный погрузчик',operations:['snow_load'],rate:3000},
  {id:'truck1',name:'Учебный самосвал 1',operations:['snow_haul','snow_unload'],rate:2400,bodyM3:10},
  {id:'truck2',name:'Учебный самосвал 2',operations:['snow_haul','snow_unload'],rate:2400,bodyM3:10}
];

export function calculateHaul(input,shiftFleet,options){
  if(!options || !['sample','shift'].includes(options.fleetMode) || typeof options.sitePermitted!=='boolean')throw Error('Укажите парк и статус учебной площадки');
  const {volume,siteCapacity,loadRate,driveMin,unloadMin,siteBusyUntil}=options;
  for(const [value,min,max] of [[volume,1,1000000],[siteCapacity,0,1000000],[loadRate,1,6000],[driveMin,1,1440],[unloadMin,1,1440],[siteBusyUntil,0,1440]]){
    if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Проверьте объёмы, производительность и времена. Используйте целые числа.');
  }
  const fleet=options.fleetMode==='sample'?sampleHaulFleet:shiftFleet.filter(v=>input.vehicleIds.includes(v.id)).map(v=>({...v,rate:input.rates?.[v.id]??v.rate}));
  const haulers=fleet.filter(v=>Number.isInteger(v.bodyM3) && v.bodyM3>0 &&
    !resourceReason(v,input,'snow_haul') && !resourceReason(v,input,'snow_unload'));
  const loader=fleet.filter(v=>!resourceReason(v,input,'snow_load'))
    .sort((a,b)=>Number(haulers.includes(a))-Number(haulers.includes(b)) || a.rate-b.rate)[0];
  const trucks=haulers.filter(v=>v.id!==loader?.id).map(vehicle=>({vehicle,ready:0}));
  const trips=[],budget=Math.round(input.budget*100);
  let delivered=0,spent=0,loaderFree=0,siteFree=siteBusyUntil,reason='';
  if(!options.sitePermitted)reason='Для площадки не задан учебный допуск';
  else if(!loader)reason='Нет доступного погрузчика с операцией погрузки';
  else if(!trucks.length)reason='Нужен отдельный доступный самосвал с объёмом кузова и операциями вывоза и разгрузки';
  while(!reason && delivered<volume){
    if(delivered===siteCapacity){reason='Исчерпана вместимость площадки';break;}
    let best=null,anyTime=false;
    for(const truck of trucks){
      const start=Math.max(loaderFree,truck.ready);
      function candidate(amount){
        const depart=start+Math.ceil(amount*60/loadRate),arrive=depart+driveMin;
        const unload=Math.max(arrive,siteFree),finish=unload+unloadMin,back=finish+driveMin;
        const cents=Math.ceil(((depart-start)*Math.round(loader.rate*100)+(back-start)*Math.round(truck.vehicle.rate*100))/60);
        return {amount,start,depart,arrive,unload,finish,back,cents};
      }
      // Duration and cost never decrease as load size grows. Find the largest feasible integer load.
      let lo=1,hi=Math.min(volume-delivered,siteCapacity-delivered,truck.vehicle.bodyM3),trip=null;
      while(lo<=hi){
        const mid=Math.floor((lo+hi)/2),c=candidate(mid);
        if(c.back<=input.shiftMin)anyTime=true;
        if(c.back<=input.shiftMin && spent+c.cents<=budget){trip=c;lo=mid+1;}
        else hi=mid-1;
      }
      if(trip && (!best || trip.start<best.trip.start || (trip.start===best.trip.start && trip.cents/trip.amount<best.trip.cents/best.trip.amount)))best={truck,trip};
    }
    if(!best){reason=anyTime?'Недостаточно бюджета на следующий рейс':'Недостаточно времени на рейс с возвратом';break;}
    const {truck,trip}=best;
    loaderFree=trip.depart;siteFree=trip.finish;truck.ready=trip.back;delivered+=trip.amount;spent+=trip.cents;
    trips.push({...trip,truck:truck.vehicle.name,truckId:truck.vehicle.id,wait:trip.unload-trip.arrive});
  }
  return {mode:'simulation',fleetMode:options.fleetMode,loader:loader?.name,delivered,remaining:volume-delivered,cost:spent/100,reason,trips};
}