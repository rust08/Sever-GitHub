import {policy, passesForEdge, fleetSeed, makePasses} from './policy.mjs';
import {plan} from './planner.mjs';
// Immutable city geography is loaded once per server/worker. SQL holds saved shifts.
export function createCatalog(network) {
  if (network.scope !== 'city' || !network.version) throw new Error('Нужен версионный снимок городской сети');
  return {network, tasks:makePasses(network), fleet:fleetSeed, policy, defaultIncidents:[]};
}
export class InputError extends Error {}
function ensure(valid,message) { if (!valid) throw new InputError(message); }
function validateFleet(fleet) {
  ensure(Array.isArray(fleet) && fleet.length, 'Добавьте машину в парк');
  const ids = new Set();
  const textField = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
  const bounded = (value,max) => Number.isFinite(value) && value > 0 && value <= max;
  return fleet.map(vehicle => {
    ensure(vehicle && typeof vehicle === 'object','Проверьте карточку машины');
    const {id,name,type,rate,workKmh,driveKmh} = vehicle;
    ensure(textField(id) && !ids.has(id),'Идентификаторы машин должны быть уникальны');
    ensure(textField(name) && textField(type),'Укажите название и тип машины (до 120 символов)');
    ensure(bounded(rate,1000000) && rate >= 0.01,'Проверьте тариф машины');
    ensure(bounded(workKmh,200) && bounded(driveKmh,200),'Задайте скорости расчистки и переезда от 0 до 200 км/ч, исключая ноль');
    ids.add(id);
    return {id,name:name.trim(),type:type.trim(),rate,workKmh,driveKmh};
  });
}
function confirmedPasses(ids, edges) {
  ensure(Array.isArray(ids) && new Set(ids).size === ids.length,
    'Проверьте список подтверждённых вызовов и повторы направлений');
  if (!ids.length) return [];
  const byId = new Map(edges.map(edge => [String(edge.id), edge]));
  return ids.map(id => {
    const match = typeof id === 'string' && /^pass:(.+):[fr]$/.exec(id);
    const edge = match && byId.get(match[1]);
    const pass = edge && passesForEdge(edge, true).find(candidate => candidate.id === id);
    ensure(pass, 'Неизвестный участок или недоступное направление срочного вызова');
    return pass;
  });
}

function prepareShift(raw,data) {
  ensure(raw && typeof raw==='object','Требуются параметры смены');
  const {date,start,shiftMin,budget,vehicleIds,closed=[],incidents=data.defaultIncidents,rates={}}=raw;
  ensure(typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10)===date,'Проверьте дату смены');
  ensure(typeof start==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(start),'Проверьте время начала');
  ensure(Number.isInteger(shiftMin) && shiftMin>=1 && shiftMin<=1440,'Продолжительность смены от 1 до 1440 минут');
  ensure(Number.isFinite(budget) && budget>=0 && budget<=100000000 && Math.abs(budget*100-Math.round(budget*100))<0.00001,'Проверьте бюджет в рублях');
  function ids(list,allowed) {
    const known=new Set(allowed);
    ensure(Array.isArray(list) && list.length<=allowed.length && list.every(id=>known.has(id)) && new Set(list).size===list.length,'Неизвестный или повторяющийся идентификатор'); return list;
  }
  const fleet=raw.fleet===undefined ? undefined : validateFleet(raw.fleet);
  const strategy=raw.strategy??'economy';
  ensure(['parallel','economy'].includes(strategy),'Выберите режим распределения машин');
  const fleetIds=(fleet??data.fleet).map(v=>v.id);
  ids(vehicleIds,fleetIds); ensure(vehicleIds.length>0,'Выберите хотя бы одну машину');
  ids(closed,data.network.edges.map(e=>e.id));
  const confirmed = confirmedPasses(incidents,data.network.edges);
  ensure(rates && typeof rates==='object' && !Array.isArray(rates) && Object.entries(rates).every(([k,v])=>fleetIds.includes(k)&&Number.isFinite(v)&&v>0&&v<=1000000),'Проверьте тарифы техники');
  const input={date,start,shiftMin,budget,vehicleIds,closed,incidents,rates,strategy,...(fleet?{fleet}:{})};
  return {input,confirmed};
}
export function validate(raw,data) {
  return prepareShift(raw,data).input;
}
// Large shifts repeat the same omission reasons and street names thousands of times.
// Keep small snapshots readable; the prefix distinguishes compressed rows from legacy JSON.
const compressedShiftPrefix = 'gzip-v1:';

async function encodeShiftResult(result) {
  const json = JSON.stringify(result);
  if (json.length < 32768) return json;
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return compressedShiftPrefix + btoa(binary);
}

async function decodeShiftResult(value) {
  if (!value.startsWith(compressedShiftPrefix)) return JSON.parse(value);
  const binary = atob(value.slice(compressedShiftPrefix.length));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

export function calculateShift(data,body) {
  const {input, confirmed} = prepareShift(body,data);
  const required = new Map(data.tasks.map(task => [task.id, task]));
  for (const pass of confirmed) required.set(pass.id, pass);
  const tasks = [...required.values()];
  const fleet=(input.fleet??data.fleet).map(v=>({...v,rate:Object.hasOwn(input.rates,v.id)?input.rates[v.id]:v.rate}));
  const result=plan(data.network,tasks,fleet,input);
  result.priorities=confirmed;
  const id=crypto.randomUUID();
  return {id,input,result};
}

export async function api(db,method,path,body,data) {
  if (method==='GET' && path==='/api/data') {
    const [latest]=await db.rows('SELECT id,input_json,result_json FROM city_plans WHERE network_version=? ORDER BY seq DESC LIMIT 1',[data.network.version]);
    return {...data,latest:latest?{id:latest.id,input:JSON.parse(latest.input_json),result:await decodeShiftResult(latest.result_json)}:null};
  }
  if (method==='POST' && path==='/api/plans') {
    const {id,input,result}=calculateShift(data,body);
    await db.batch([['INSERT INTO city_plans(network_version,id,shift_date,input_json,result_json) VALUES(?,?,?,?,?)',[data.network.version,id,input.date,JSON.stringify(input),await encodeShiftResult(result)]]]);
    return {id,input,result};
  }
  return null;
}
