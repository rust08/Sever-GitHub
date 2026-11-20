import {workTypes} from './governance.mjs';

// Times in vehicle cards are entered as local Kamchatka wall times.
function shiftInstant(value){
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))return NaN;
  const utc=Date.parse(value+'Z');
  if(!Number.isFinite(utc) || new Date(utc).toISOString().slice(0,16)!==value)return NaN;
  return Date.parse(value+':00+12:00');
}
export function equipmentFields(v){
  const result={};
  if(v.operations!==undefined){
    if(!Array.isArray(v.operations)||v.operations.some(op=>!Object.hasOwn(workTypes,op))||new Set(v.operations).size!==v.operations.length)
      throw Error('Проверьте операции машины');
    result.operations=v.operations;
  }
  if(v.availability!==undefined){
    if(!['demo','unknown','unavailable','reported'].includes(v.availability))throw Error('Проверьте доступность машины');
    result.availability=v.availability;
    if(v.availability==='reported'){
      const start=shiftInstant(v.availableFrom),end=shiftInstant(v.availableUntil);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||typeof v.availabilitySource!=='string'||!v.availabilitySource.trim()||v.availabilitySource.length>240)
        throw Error('Для доступности машины укажите начало, конец и основание');
      Object.assign(result,{availableFrom:v.availableFrom,availableUntil:v.availableUntil,availabilitySource:v.availabilitySource.trim()});
    }
  }
  for(const key of ['widthM','massT','maxGradePct']){
    if(v[key]==null || v[key]==='')continue;
    if(!Number.isFinite(v[key])||v[key]<0||(key!=='maxGradePct' && !v[key]))throw Error('Проверьте габариты, массу и допустимый уклон машины');
    result[key]=v[key];
  }
  if(v.bodyM3!=null && v.bodyM3!==''){
    if(!Number.isSafeInteger(v.bodyM3)||v.bodyM3<=0||v.bodyM3>1000)throw Error('Проверьте объём кузова: 1–1000 м³');
    result.bodyM3=v.bodyM3;
  }
  if(v.payloadKg!=null && v.payloadKg!==''){
    if(!Number.isSafeInteger(v.payloadKg)||v.payloadKg<=0)throw Error('Укажите грузоподъёмность в целых положительных килограммах');
    result.payloadKg=v.payloadKg;
  }
  if(v.tareKg!=null && v.tareKg!==''){
    if(!Number.isSafeInteger(v.tareKg)||v.tareKg<=0)throw Error('Укажите массу порожней машины в целых кг');
    result.tareKg=v.tareKg;
  }
  return result;
}
export function resourceReason(v,input,operation){
  if(v.availability==='unavailable')return 'Машина недоступна';
  if(v.availability==='unknown')return 'Доступность машины неизвестна';
  if(v.availability==='reported'){
    const start=shiftInstant(input.date+'T'+input.start);
    if(start<shiftInstant(v.availableFrom)||start+input.shiftMin*60000>shiftInstant(v.availableUntil))return 'Интервал доступности не покрывает смену';
  }
  if(!(v.operations??['patrol_plow']).includes(operation))return 'В карточке машины отсутствует выбранная операция';
  return null;
}
export function checkWorksite(vehicle,limits){
  if(!limits || typeof limits!=='object'||Array.isArray(limits))throw Error('Проверьте ограничения участка');
  const missing=[],conflicts=[];
  for(const [key,attr,title] of [['clearWidthM','widthM','Ширина прохода'],['maxMassT','massT','Допустимая масса'],['gradePct','maxGradePct','Уклон участка']]){
    const value=limits[key];
    if(value==null)continue;
    if(!Number.isFinite(value)||value<0||(key!=='gradePct' && !value))throw Error('Проверьте значение: '+title);
    if(vehicle[attr]==null)missing.push(title+' — требуется параметр машины');
    else if(key==='gradePct'?value>vehicle[attr]:vehicle[attr]>value)conflicts.push(title+' — ограничение превышено');
  }
  return {missing,conflicts};
}