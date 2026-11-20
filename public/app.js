import { initWorkflows } from './workflows.js';
import {initDashboard} from './dashboard.js';
import { RoadMap } from './map.js';
import {createFleetEditor} from './fleet-ui.js';

const $ = id => document.getElementById(id);
const format = (value, digits = 0) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
const money = value => format(value) + ' ₽';
const colors = ['#0368a6','#ad5414','#00816c','#8c4797','#aa3556','#436a39','#5358ab','#795433'];
let data, plan, roadMap;
let tasks = new Map();
let edges = new Map();
const roadOptions = new Map(), byRoad=new Map(), callOptions=new Map();
let closedRoads=new Set(), incidentIds=new Set();
let saving = false;
let scheduledTasks = new Map(), skippedTasks = new Map();
const pickColor = id => colors[Math.max(0,plan?.result.routes.findIndex(v => v.vehicleId === id) ?? 0) % colors.length];

function add(parent, tag, value, className) {
  const child = document.createElement(tag);
  if (value != null) child.textContent = value;
  if (className) child.className = className;
  parent.append(child);
  return child;
}
function table(parent, headers) {
  const el = add(add(parent, 'div', null, 'table-wrap'), 'table');
  const tr = add(add(el, 'thead'), 'tr');
  for (const header of headers) add(tr, 'th', header).scope = 'col';
  return add(el, 'tbody');
}
function clock(offset) {
  const [hours, minutes] = (plan?.input.start || $('start').value || '08:00').split(':').map(Number);
  const time = hours * 60 + minutes + Math.ceil(offset);
  return String(Math.floor(time / 60) % 24).padStart(2, '0') + ':' + String(time % 60).padStart(2, '0') + (time >= 1440 ? ' (+1)' : '');
}
async function api(path, payload) {
  if (globalThis.severDemo) return globalThis.severDemo.request(path,payload);
  const options = payload ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) } : {};
  const response = await fetch(path, options);
  let body;
  try { body = await response.json(); } catch { throw new Error('Сервер вернул нечитаемый ответ.'); }
  if (!response.ok) throw new Error(body?.error?.message || body?.error || 'Ошибка расчёта');
  return body;
}
function initialDate() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kamchatka', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function markChanged() {
  $('discard').hidden=!plan;
  $('save-state').textContent = 'Изменения ожидают расчёта. Маршруты и времена относятся к сохранённому плану.';
}
let fleetEditor;
function populate(input) {
  $('date').value = input?.date || initialDate();
  $('start').value = input?.start || '08:00';
  $('duration').value = input?.shiftMin ?? 240;
  $('budget').value = input?.budget ?? 30000;
  $('strategy').value = input?.strategy ?? 'parallel';
  const vehicles=input?.fleet??data.fleet;
  fleetEditor??=createFleetEditor($('fleet'),$('add-vehicle'),data.workTypes,markChanged,()=>({
    date:$('date').value,start:$('start').value,shiftMin:$('duration').valueAsNumber
  }));
  fleetEditor.reset(vehicles,input?.vehicleIds??vehicles.map(v=>v.id),input?.rates);
  closedRoads = new Set((input?.closed || []).map(String).filter(id=>edges.has(id)));
  incidentIds=new Set((input?.incidents??data.defaultIncidents).map(String));
  if($('call-search')){drawPicker(false);drawPicker(true);return;}
  const counts=new Map();
  for (const edge of data.network.edges) {
    const name=edge.name || 'Проезд без названия';
    const ordinal=(counts.get(name)||0)+1;
    counts.set(name,ordinal);
    roadOptions.set(String(edge.id),name+' · участок '+ordinal+' · '+Math.round(edge.km*1000)+' м');
  }
  for (const task of data.tasks) {
    const key=String(task.edgeId);
    if (!byRoad.has(key)) byRoad.set(key,[]);
    byRoad.get(key).push(task);
    callOptions.set(String(task.id),task);
  }
  if(data.network.scope==='city') {
    for(const [key,edge] of edges) {
      if(edge.routable===false || byRoad.has(key)) continue;
      const directions=edge.oneway?[false]:[false,true];
      const passes=directions.map(reverse=>({
        id:'pass:'+key+':'+(reverse?'r':'f'), edgeId:edge.id, reverse, optional:true,
        name:(edge.name || 'Участок '+key)+(reverse?' · обратно':'')
      }));
      byRoad.set(key,passes);
      for(const pass of passes)callOptions.set(pass.id,pass);
    }
  }
  incidentIds=new Set((input?.incidents ?? data.defaultIncidents).map(String).filter(id=>callOptions.has(id)));
  const search=add($('incidents').parentElement,'input');
  search.type='search'; search.placeholder='Найти улицу для вызова'; search.id='call-search';
  search.setAttribute('aria-label',search.placeholder); $('incidents').before(search);
  search.oninput=()=>drawPicker(true);
  drawPicker(false); drawPicker(true);
}
function locate(edgeId) {
  if(!$('map').getClientRects().length)navigateDashboard('overview');
  roadMap?.focus(edgeId);
  $('map').scrollIntoView({block:'center',behavior:'smooth'});
}
function direction(task) {return task.reverse?'обратный проход':'прямой проход';}
function toggleEntry(isCall,id) {
  if(saving)return;
  const selected=isCall?incidentIds:closedRoads;
  if(selected.has(id))selected.delete(id); else selected.add(id);
  drawPicker(isCall); syncDraft(); markChanged();
}
function syncDraft() {
  $('closed-count').textContent=closedRoads.size;
  roadMap?.updateDraft([...closedRoads]);
  roadMap?.updateIncidents([...incidentIds]);
  if(roadMap?.selected!=null)showRoad(roadMap.selected);
}
function drawPicker(isCall) {
  const selected=isCall?incidentIds:closedRoads;
  const root=$(isCall?'incidents':'closures'); root.replaceChildren();
  const term=$(isCall?'call-search':'road-search').value.trim().toLocaleLowerCase('ru');
  const entries=isCall?callOptions:edges;
  const matches=[];
  for (const [id,entry] of entries) {
    const edgeId=isCall?String(entry.edgeId):id;
    const title=roadOptions.get(edgeId)+(isCall?' · '+direction(entry):'');
    if ((!term || title.toLocaleLowerCase('ru').includes(term))) matches.push({id,edgeId,title});
  }
  matches.sort((a,b)=>Number(selected.has(b.id))-Number(selected.has(a.id)));
  for (const {id,edgeId,title} of matches.slice(0,35)) {
    const row=add(root,'div',null,'road-option');
    const check=add(row,'input'); check.type='checkbox';check.checked=selected.has(id);
    check.setAttribute('aria-label',(isCall?'Срочный вызов: ':'Перекрытие: ')+title);
    check.onchange=()=>toggleEntry(isCall,id);
    const btn=add(row,'button',title,'row-button');btn.type='button';btn.onclick=()=>locate(edgeId);
  }
  if(matches.length>35)add(root,'p','Первые 35 из '+format(matches.length)+'. Уточните название или выберите дорогу на карте.','note');
  if(!matches.length)add(root,'p','По запросу ничего не найдено.','note');
}
const stageNames={planned:'Запланирован',dispatched:'Выдан',started:'Начат',machine_reported:'Заявлен исполнителем',
  inspector_verified:'Проверен инспектором',accepted:'Принят заказчиком',rejected:'Отклонён',disputed:'Оспорен'};
const roleNames={dispatcher:'Диспетчер',operator:'Оператор',inspector:'Инспектор',customer:'Заказчик',executor:'Исполнитель'};
const evidenceNames={dispatched:'Наряд',started:'Отметка начала операции',machine_reported:'Отчёт о выполнении операции',
  inspector_verified:'Протокол осмотра',accepted:'Акт приёмки',rejected:'Акт замечаний',disputed:'Возражение исполнителя'};
let orderEdge, orderRevision=0;
function syncOrderVehicles(){
  const select=$('order-vehicle'), previous=select.value;
  const fleet=(plan.input.fleet??data.fleet).filter(v=>plan.input.vehicleIds.includes(v.id));
  select.replaceChildren(...fleet.map(v=>new Option(v.type?v.name+' · '+v.type:v.name,v.id)));
  if(fleet.some(v=>v.id===previous))select.value=previous;
  $('order-offset').max=plan.input.shiftMin;
}
function downloadOrder(report,filename='sever-order-'+report.shift.date+'.json'){
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url;link.download=filename;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function openOrder(edgeId){
  if(orderEdge!==edgeId)for(const id of ['limit-width','limit-mass','limit-grade'])$(id).value='';
  orderEdge=edgeId;workflows?.orderSelected?.();
  navigateDashboard('orders');
  const box=$('order-panel');box.open=true;
  $('order-operation').replaceChildren(...Object.entries(data.workTypes).map(([value,title])=>new Option(title,value)));
  const edge=edges.get(String(edgeId));
  $('order-direction').replaceChildren(new Option('Прямое','f'));
  if(!edge.oneway)$('order-direction').add(new Option('Обратное','r'));
  $('order-road').textContent=roadOptions.get(String(edgeId));
  if(plan)syncOrderVehicles();
  refreshOrder();box.scrollIntoView({block:'center'});
}
const sampleRow={edgeId:'w31172948-2001790818-2003931756',operation:'patrol_plow',customer:'Учебный заказчик',executor:'Учебная служба',officer:'Учебный диспетчер',
  contractId:'DEMO-01',source:'Учебная адресная ведомость',clause:'Строка 1',reviewer:'Учебный проверяющий',from:'2026-01-01',until:'2027-01-01'};
let registryAttachment=null, selectedRegistryRef=null;
const sampleAttachment={mode:'simulation',networkVersion:'pkgo-27233df581c6',rows:[sampleRow,{...sampleRow,edgeId:'unmapped-demo',clause:'Строка 2'}]};
$('attachment-save').onclick=()=>downloadOrder(sampleAttachment,'sever-training-scope.json');
$('attachment-show').onclick=()=>{registryAttachment=null;$('attachment-file').value='';roadMap?.focus(sampleRow.edgeId);openOrder(sampleRow.edgeId);};
async function refreshOrder(action){
  if(orderEdge==null || !plan)return;
  const revision=++orderRevision;
  const offset=$('order-offset'), vehicle=$('order-vehicle');
  offset.disabled=!$('order-event').checked;
  const repeat=$('clock-repeat');
  repeat.disabled=offset.disabled;repeat.min=String(Number(offset.value)+1);repeat.max=plan.input.shiftMin;
  $('clock-kind').disabled=offset.disabled;
  const root=$('order-output');root.replaceChildren();
  if(!repeat.disabled && !repeat.checkValidity()){root.textContent='Повторное событие должно быть позже первого и попадать в смену.';return;}
  if(!offset.disabled && (!offset.value || !offset.checkValidity())){
    root.textContent='Введите целое число минут от 0 до '+plan.input.shiftMin+'.';return;
  }
  const body={vehicleId:vehicle.value,eventOffsetMin:offset.disabled?0:offset.valueAsNumber,shift:plan.input,shiftId:plan.id,edgeId:orderEdge,operation:$('order-operation').value,
    scenario:$('order-case').value,reverse:$('order-direction').value==='r',withEvent:$('order-event').checked};
  Object.assign(body,{objectType:$('clock-object').value,queue:Number($('clock-queue').value),
    eventKind:offset.disabled?'snowfall_end':$('clock-kind').value,repeatOffsetMin:!repeat.disabled && repeat.value!==''?repeat.valueAsNumber:null});
  body.worksite={};
  for(const [key,id] of Object.entries({clearWidthM:'limit-width',maxMassT:'limit-mass',gradePct:'limit-grade'})){
    const el=$(id);if(!el.checkValidity()){root.textContent='Проверьте ограничения выбранного участка.';return;}
    if(el.value!=='')body.worksite[key]=el.valueAsNumber;
  }
  $('attachment-controls').hidden=body.scenario!=='attachment';
  if(body.scenario==='attachment'){
    try{
      const file=$('attachment-file').files[0];
      if(file && file.size>64000)throw Error('Максимальный размер 64 КБ');
      body.attachment=file?JSON.parse(await file.text()):(registryAttachment??sampleAttachment);
      if(revision!==orderRevision)return;
    }catch(error){if(revision===orderRevision)root.textContent='Проверьте JSON: '+error.message;return;}
  }
  const parts=[data.network.version,plan.id,orderEdge,body.operation,body.scenario,body.reverse,body.withEvent];
  if(body.objectType!=='roadway' || body.queue!==1 || body.eventKind!=='snowfall_end' || body.repeatOffsetMin!==null)
    parts.push(body.objectType,body.queue,body.eventKind,body.repeatOffsetMin);
  if(Object.keys(body.worksite).length)parts.push(body.worksite);
  if(vehicle.selectedIndex>0 || body.eventOffsetMin)parts.push(body.vehicleId,body.eventOffsetMin);

  try{
    if(body.attachment){
      const bytes=new TextEncoder().encode(JSON.stringify(body.attachment));
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      parts.push(Array.from(hash,b=>b.toString(16).padStart(2,'0')).join(''));
      if(revision!==orderRevision)return;
    }
    const key='sever-governance-v1:'+JSON.stringify(parts);
    const history=JSON.parse(localStorage.getItem(key)||'[]');
    if(action)history.push({...action,at:new Date().toISOString()});
    const result=await api('/api/orders/preview',{...body,history});
    if(revision!==orderRevision)return;
    if(action)localStorage.setItem(key,JSON.stringify(result.history));
    const m=result.mandate;
    add(root,'strong',{eligible:'Учебный допуск подтверждён',blocked:'Назначение заблокировано',manual_review:'Нужно ручное согласование'}[m.status]);
    add(root,'p','Ответственный: '+(result.responsibility?.officer||'не подтверждён')+' · исполнитель: '+(result.responsibility?.executor||'не подтверждён'));
    for(const reason of [...m.missing,...m.conflicts])add(root,'p',reason);
    if(result.attachment){
      add(root,'p','Совпавших строк: '+result.attachment.matchCount+'. Без геометрии: '+(result.attachment.unmatched.join(', ')||'нет')+'.');
      if(result.contract)add(root,'p','Основание: '+result.contract.id+' · '+result.contract.document+' · '+result.contract.clause+' · проверил: '+result.contract.reviewer);
    }
    const localTime=value=>new Date(value).toLocaleString('ru-RU',{timeZone:'Asia/Kamchatka'});
    if(result.contract)add(root,'p','Учебный договор действует до '+localTime(result.contract.end)+' (Камчатка), исключая этот момент.');
    for(const {event,rule,clock} of result.episodes){
      if(event)add(root,'p',(event.kind==='ice_detected'?'Обнаружена скользкость':'Снегопад закончился')+' '+localTime(event.at)+' (учебное событие, Камчатка).');
      if(clock.dueAt)add(root,'p','Учебный срок: '+localTime(clock.dueAt)+' (Камчатка) · '+rule.minutes+' мин · '+rule.version+' · '+rule.clause);
      else if(!rule)add(root,'p','Срок неизвестен: нет применимой учебной редакции для объекта, очереди, операции и даты.');
      else add(root,'p','Для запуска срока требуется событие: '+(rule.clockStart==='ice_detected'?'обнаружение скользкости.':'окончание снегопада.'));
    }
    const route=result.routing;
    if(route)add(root,'p',route.assigned?'Отдельный расчёт: '+route.vehicle+' · с возвратом '+format(route.minutes,1)+' мин · '+money(route.cost):route.reason);
    add(root,'strong','Учебный журнал · '+stageNames[result.state]);
    for(const e of result.history)add(root,'p',new Date(e.at).toLocaleString('ru-RU',{timeZone:'Asia/Kamchatka'})+' · '+roleNames[e.role]+' · '+stageNames[e.state]+' · '+e.evidence);
    const report={formatVersion:1,notice:'Учебная симуляция. Все договоры, сроки и записи исполнения в этой карточке условные.',
      networkVersion:data.network.version,shift:{id:body.shiftId,date:body.shift.date,start:body.shift.start,timeZone:'Asia/Kamchatka',
        minutes:body.shift.shiftMin,budgetRub:body.shift.budget},road:$('order-road').textContent,edgeId:body.edgeId,
      direction:body.reverse?'Обратное':'Прямое',vehicleId:body.vehicleId,vehicleLabel:vehicle.selectedOptions[0].textContent,
      scenario:body.scenario,operationName:data.workTypes[body.operation],...result};
    const download=add(root,'button','Скачать карточку наряда (JSON)','row-button');
    download.type='button';download.onclick=()=>downloadOrder(report);
    for(const next of result.actions){
      const btn=add(root,'button',roleNames[next.role]+' · '+evidenceNames[next.state],'row-button');btn.type='button';
      btn.onclick=()=>refreshOrder({...next,orderId:result.id,actor:roleNames[next.role]+' (учебная роль)',evidenceKind:next.state,evidence:evidenceNames[next.state]+' (образец)'});
    }
  }catch(error){if(revision===orderRevision)root.textContent='Не удалось открыть или сохранить наряд: '+error.message;}
}

function showRoad(id) {
  const root=$('map-info'), key=String(id),title=roadOptions.get(key);root.replaceChildren();root.hidden=!title;
  if(!title)return;
  const close=add(root,'button','×','row-button');close.type='button';close.setAttribute('aria-label','Закрыть карточку');close.onclick=()=>{root.hidden=true;};
  add(root,'strong',title);
  add(root,'p','Дорожная сеть OSM · сценарные приоритеты','sub');
  if(roadMap?.mode==='coverage'){
    const rows=roadMap.coverage?.get(key)??[];
    if(!roadMap.coverage)add(root,'p','Срез сейчас недоступен.');
    else if(!rows.length)add(root,'p','В выбранном срезе нет строки реестра.');
    else {
      add(root,'p',rows.length>1?'Пересечение строк — требуется проверка.':$('coverage-source').selectedOptions[0].textContent);
      for(const r of rows)add(root,'p',r.contract_id+' · ред. '+r.revision+' · '+r.executor+' · '+r.source+', '+r.clause);
    }
    return;
  }
  const review=add(root,'button','Проверить учебный наряд','row-button');review.type='button';review.onclick=()=>openOrder(edges.get(key).id);
  const edgeTasks=byRoad.get(key)||[];
  for(const t of edgeTasks){
    const urgent=incidentIds.has(String(t.id));
    const status=urgent?'P1 · срочный вызов':t.optional?'транзитный проезд':'P'+t.priority+' · '+t.reason;
    add(root,'p',direction(t)+' · '+status);
    const item=scheduledTasks.get(String(t.id)),minute=Number($('minute').value);
    if(item) {
      const {leg,route}=item;
      const state=minute<leg.startMin?'Запланирован':minute<leg.endMin?'В работе по плану':'Завершён по плану';
      add(root,'p',state+' · '+route.name+' · '+clock(leg.startMin)+'–'+clock(leg.endMin));
    } else if(skippedTasks.has(String(t.id))) add(root,'p',skippedTasks.get(String(t.id)));
    const btn=add(root,'button',urgent?'Снять срочный вызов':'Подтвердить срочный вызов','row-button');
    btn.type='button';btn.disabled=saving;btn.onclick=()=>toggleEntry(true,String(t.id));
  }
  if(!edgeTasks.length)add(root,'p','Проезд техники по участку недоступен в дорожной модели.');
  const blocked=closedRoads.has(key);
  const pending=(plan?.input.closed||[]).some(v=>String(v)===key)!==blocked;
  add(root,'p',(blocked?'Закрыт':'Открыт')+(pending?' · ожидает пересчёта':''));
  const btn=add(root,'button',blocked?'Открыть проезд':'Закрыть проезд','row-button');
  btn.type='button';btn.disabled=saving;btn.onclick=()=>toggleEntry(false,key);
}
function readInput() {
  const {fleet,vehicleIds,rates}=fleetEditor.serialize();
  return {date:$('date').value,start:$('start').value,shiftMin:$('duration').valueAsNumber,budget:$('budget').valueAsNumber,
    vehicleIds,closed:[...closedRoads].map(id => edges.get(id).id),
    incidents:[...incidentIds].filter(id=>callOptions.has(id)).map(id=>callOptions.get(id).id),rates,fleet,strategy:$('strategy').value};
}
async function calculate() {
  if (saving || !$('settings').reportValidity()) return;
  const input = readInput();
  if (!input.vehicleIds.length) { $('status').textContent = 'Выберите хотя бы одну машину.'; return; }
  saving = true;
  fleetEditor.setBusy(true);
  $('settings').inert = true;

  $('submit').disabled = true;
  $('status').textContent = 'Строим маршруты и проверяем ограничения…';
  try {
    const response = await api('/api/plans',input);
    renderPlan(response);
    $('status').textContent = '';
  } catch (error) { $('status').textContent = 'Расчёт не выполнен. ' + error.message; }
  finally {saving = false; fleetEditor.setBusy(false); $('settings').inert = false; $('submit').disabled = false;if(roadMap?.selected!=null)showRoad(roadMap.selected);}
}
function renderPlan(next) {
  plan = next;workflows?.planChanged();clearHaul();
  $('shift-date').textContent = new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(plan.input.date+'T00:00:00Z'));
  const ranked = new Map((plan.result.priorities || []).map(t => [String(t.id),t]));
  tasks = new Map(data.tasks.map(t => [String(t.id), {...t,...ranked.get(String(t.id))}]));
  for(const [id,override] of ranked) {
    const option=callOptions.get(id);
    if(option?.optional)tasks.set(id,{...option,...override});
  }
  const summary = plan.result.summary;
  scheduledTasks=new Map();
  for (const route of plan.result.routes) for (const leg of route.legs) if (leg.type==='work') scheduledTasks.set(String(leg.taskId),{route,leg});
  skippedTasks=new Map(plan.result.unassigned.map(item=>[String(item.taskId),item.reason]));
  const coverage=plan.result.coverage;
  $('save-state').textContent = 'Сохранённый план · ' + plan.input.date.split('-').reverse().join('.') + ' · ' + plan.input.start;
  if(!plan.input.strategy)$('save-state').textContent += '. Архивный расчёт. Чтобы применить новый режим, нажмите «Рассчитать план».';
  $('metrics').replaceChildren();
  for (const [name,value] of [
    ['Заданий в плане',summary.assigned + ' / ' + summary.total],
    ['В срок из назначенных',summary.onTime + ' / ' + summary.assigned],
    ['Расходы смены',money(summary.cost)],
    ['Дороги со всеми проходами',coverage ? format(coverage.fullyAssignedKm,1)+' / '+format(coverage.requiredNetworkKm,1)+' км' : 'Нет архивных данных'],
    ['Холостой пробег',format(summary.deadKm,1) + ' км'],
  ]) { const tile = add($('metrics'),'div',null,'metric'); add(tile,'span',name); add(tile,'strong',value); }
  add($('metrics').children[1],'small','P1 в срок · '+summary.urgentOnTime+' из '+summary.urgentTotal,'sub');
  add($('metrics').children[2],'small','Лимит '+money(plan.input.budget),'sub');
  if(coverage)add($('metrics').children[3],'small','Частично · '+format(coverage.partiallyAssignedKm,1)+' км. Сеть · '+format(coverage.networkKm,1)+' км','sub');
  $('discard').hidden=true;
  const selected = $('filter').value;
  $('filter').replaceChildren(new Option('Все машины',''), ...plan.result.routes.map(r => new Option(r.name,r.vehicleId)));
  if (plan.result.routes.some(r => String(r.vehicleId) === selected)) $('filter').value = selected;
  $('minute').max = plan.input.shiftMin;
  $('minute').value = 0;
  $('time-start').textContent = clock(0); $('time-end').textContent = clock(plan.input.shiftMin);
  $('map-count').textContent = data.network.edges.length + ' дорожных участков · ' + plan.result.routes.length + ' маш. в смене';
  $('attention').textContent=plan.result.unassigned.length?format(plan.result.unassigned.length)+' заданий осталось за пределами смены.':'Все задания включены в план.';
  $('first-jobs').replaceChildren();
  const first=plan.result.routes.flatMap(route=>route.legs.filter(leg=>leg.type==='work').slice(0,3).map(leg=>({route,leg})))
    .sort((a,b)=>a.leg.startMin-b.leg.startMin).slice(0,3);
  for(const {route,leg} of first){
    const btn=add($('first-jobs'),'button',null,'first-job');
    add(btn,'time',clock(leg.startMin));add(btn,'span',leg.name||leg.edgeId);
    btn.onclick=()=>selectLeg(route,leg);
  }
  if(!first.length)$('first-jobs').textContent='Назначенных проходов пока нет.';
  drawRoutes(); drawTasks(); drawSkipped(); refreshMap();
  if(orderEdge!=null){syncOrderVehicles();refreshOrder();}
}
function refreshMap() {
  const minute = Number($('minute').value);
  $('clock').value = clock(minute);
  roadMap?.show(plan, $('filter').value, minute);
  if(roadMap?.selected!=null && !$('map-info').hidden)showRoad(roadMap.selected);
  const list = $('vehicle-status');list.replaceChildren();
  for (const [index,route] of (plan?.result.routes || []).entries()) {
    if ($('filter').value && $('filter').value !== String(route.vehicleId)) continue;
    const leg = route.legs.find(item => minute >= item.startMin && minute < item.endMin);
    const row = add(list,'div',null,'vehicle-position');
    add(row,'b',String(index+1)).style.background=pickColor(route.vehicleId);
    add(row,'strong',route.name);
    add(row,'span',leg ? (leg.type==='work'?'Расчистка · ':'Переезд · ')+(leg.name||'Проезд')+' до '+clock(leg.endMin) : 'На базе');
  }
}
function selectLeg(route, leg) {
  if(!$('map').getClientRects().length)navigateDashboard('plan');
  $('filter').value = route.vehicleId;
  $('minute').value = leg.startMin;
  refreshMap(); roadMap.focus(leg.edgeId);
  $('map').scrollIntoView({block:'center',behavior:'smooth'});
}
function drawRoutes() {
  const root = $('routes'); root.replaceChildren();
  add(root,'p','Местное время. Выберите этап, чтобы увидеть участок и машину на карте.','sub');
  for(const v of plan.result.excludedVehicles??[])add(root,'p',v.name+' · исключена из расчистки: '+v.reason);
  for (const [i,route] of plan.result.routes.entries()) {
    if ($('filter').value && String(route.vehicleId) !== $('filter').value) continue;
    const sheet = add(root,'details',null,'sheet'); sheet.open = i === 0 || Boolean($('filter').value);
    const head = add(sheet,'summary');
    add(head,'i',null,'chip').style.background = pickColor(route.vehicleId);
    add(head,'span',route.name + ' · ' + format(route.minutes) + ' мин · ' + money(route.cost));
    if (!route.legs.length) {add(sheet,'p','Резерв, задания отсутствуют.','empty');continue;}
    const body = table(sheet,['Время','Операция','Участок','Карта']);
    for (const leg of route.legs) {
      const tr = add(body,'tr');
      add(tr,'td',clock(leg.startMin) + '–' + clock(leg.endMin),'nowrap');
      add(tr,'td',leg.type === 'work' ? 'Расчистка' : 'Переезд');
      const road = add(tr,'td',leg.name || edges.get(String(leg.edgeId))?.name || String(leg.edgeId));
      if (leg.type === 'work') {
        const task = tasks.get(String(leg.taskId));
        if (task) add(road,'small','P' + task.priority + ' · цель к ' + clock(task.targetMin) + ' · ' + (leg.endMin <= task.targetMin ? 'в срок' : 'позже цели'),'leg-status');
      }
      const button = add(add(tr,'td'),'button','Показать','row-button');button.addEventListener('click',() => selectLeg(route,leg));
    }
  }
}
function drawTasks() {
  const root = $('tasks');root.replaceChildren();
  add(root,'h3','Правила очередности');
  add(root,'p','Проектные целевые сроки отсчитываются от начала смены. Правила и признаки требуют согласования с дорожной службой.','sub');
  const grid = add(root,'div',null,'policy');
  for (const item of data.policy) {
    const rule = add(grid,'div',null,'rule');add(rule,'strong','P' + item.level + ' · ' + item.title);
    add(rule,'p',item.rule); add(rule,'p','Цель — ' + item.targetMin + ' мин.');
  }
  const solved = new Map();
  for (const route of plan.result.routes) for (const leg of route.legs) if (leg.type === 'work') solved.set(String(leg.taskId),{route,leg});
  const body = table(root,['Приоритет','Участок и основание','Цель','Назначение']);
  pagedRows(body,[...tasks.values()].sort((a,b) => a.priority-b.priority || a.name.localeCompare(b.name,'ru')),task=>{
    const tr = add(body,'tr');add(tr,'td','P'+task.priority,'prio');
    const details = add(add(tr,'td'),'details');add(details,'summary',task.name);
    add(details,'p',task.reason);add(details,'small','Участок ' + task.edgeId + ' · ' + (task.reverse ? 'обратное направление' : 'прямое направление'));
    add(tr,'td',clock(task.targetMin),'nowrap');
    const item = solved.get(String(task.id));
    add(tr,'td',item ? item.route.name + ' · ' + clock(item.leg.startMin) + '–' + clock(item.leg.endMin) : 'Без назначения');
  });
}
function pagedRows(body,items,draw) {
  const panel=body.closest('.page');
  let offset=0;
  const next=add(panel,'button','', 'row-button');next.type='button';
  function append(){
    for(const item of items.slice(offset,offset+60))draw(item);
    offset+=60;
    next.hidden=offset>=items.length;
    next.textContent='Показать ещё · осталось '+format(Math.max(0,items.length-offset));
  }
  next.onclick=append;append();
}
function drawSkipped() {
  const root = $('unassigned'); root.replaceChildren();
  const entries = plan.result.unassigned;
  document.querySelector('[data-page=unassigned]').textContent = 'Без назначения · ' + entries.length;
  if (!entries.length) {add(root,'p','Все задания включены в план.','empty'); return;}
  const body = table(root,['Участок','Приоритет','Причина']);
  pagedRows(body,entries,item=>{
    const task = tasks.get(String(item.taskId));
    const row = add(body,'tr');const cell=add(row,'td');
    if(task){const link=add(cell,'button',task.name,'row-button');link.onclick=()=>locate(task.edgeId);}
    else cell.textContent=item.taskId;add(row,'td','P'+(task?.priority || '—'));add(row,'td',item.reason);
  });
}
async function init() {
  $('hosted-sharing').hidden=Boolean(globalThis.severDemo) || ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  try {
    data = await api('/api/data');
    edges = new Map(data.network.edges.map(edge => [String(edge.id),edge]));
    tasks = new Map(data.tasks.map(task => [String(task.id),task]));
    populate(data.latest?.input);
    $('workspace').hidden = false;
    initRegistry();
    roadMap = new RoadMap($('map'),data.network,pickColor,showRoad,data.tasks);
    initCoverage();
    syncDraft();
    $('status').textContent = '';
    if (data.latest) renderPlan(data.latest); else await calculate();
  } catch(error) {
    $('status').textContent = 'Не удалось загрузить пульт. ' + error.message;
    add($('status'),'button','Повторить').onclick = () => location.reload();
  }
}
const navigateDashboard=initDashboard();
$('jump-routes').addEventListener('click', () => document.querySelector('[data-page=routes]').click());
$('discard').onclick=()=>{
  if(!plan||!confirm('Восстановить параметры, парк и перекрытия последнего расчёта?'))return;
  populate(plan.input);syncDraft();renderPlan(plan);
};
$('settings').addEventListener('submit',e => {e.preventDefault(); calculate();});
$('settings').addEventListener('input',e => {
  if (e.target.type === 'search') return;
  markChanged();
});
for(const id of ['date','start','duration'])$(id).addEventListener('change',()=>fleetEditor?.refresh());
$('road-search').addEventListener('input',e => {
  drawPicker(false);
});
$('minute').addEventListener('input',refreshMap);
$('filter').addEventListener('change',() => {refreshMap(); if(plan)drawRoutes();});
$('zoom-in').onclick = () => roadMap?.zoom(1.5);
$('zoom-out').onclick = () => roadMap?.zoom(1/1.5);
$('fit').onclick = () => roadMap?.fit();
document.querySelector('.tabs').addEventListener('click',e => {
  const button = e.target.closest('[data-page]'); if (!button) return;
  for (const tab of document.querySelectorAll('[data-page]')) {
    const visible = tab === button;
    tab.classList.toggle('active',visible); tab.setAttribute('aria-pressed',String(visible)); $(tab.dataset.page).hidden = !visible;
  }
});
$('order-panel').addEventListener('change',()=>refreshOrder());
init();

function initRegistry(){
  const panel=$('registry-panel');
  if(globalThis.severDemo || !['localhost','127.0.0.1'].includes(location.hostname))return;
  panel.hidden=false;
  const versions=$('reg-version'), status=$('reg-status'), detail=$('reg-detail');
  let opened=null,example=false,requestId=0;
  const fields={contractId:'Номер договора',edgeId:'Идентификатор участка',objectType:'Тип объекта',jurisdiction:'Юрисдикция',owner:'Владелец',balanceHolder:'Балансодержатель',
    customer:'Заказчик',executor:'Исполнитель',officer:'Ответственный за поручение',source:'Название документа',clause:'Лист или пункт приложения',reviewer:'Проверяющий',
    operation:'Вид работ',from:'Действует с',until:'До начала дня'};
  for(const [key,title] of Object.entries(fields)){
    const label=add($('reg-fields'),'label',title);
    const input=add(label,key==='operation'?'select':'input');input.id='reg-field-'+key;
    if(key==='operation')for(const [value,name] of Object.entries(data.workTypes))input.add(new Option(name,value));
    if(['from','until'].includes(key))input.type='date';
  }
  $('reg-edge').onclick=()=>{
    const id=roadMap?.selected;
    if(!id){status.textContent='Сначала нажмите на участок городской карты.';return;}
    $('reg-field-edgeId').value=id;
    status.textContent='Выбран участок '+(edges.get(id)?.name||id);
  };
  const modeName=mode=>mode==='simulation'?'Учебная запись':'Документ на проверке';
  function controls(busy){
    for(const el of panel.querySelectorAll('input,select,button'))el.disabled=busy;
  }
  async function list(selected=''){
    const records=await api('/api/registry');
    versions.replaceChildren(new Option('Новая запись',''),...records.map(r=>
      new Option(r.contract_id+' · ред. '+r.revision+' · '+modeName(r.mode),JSON.stringify([r.contract_id,r.revision]))));
    versions.value=selected;
    await show();
  }
  async function show(){
    const serial=++requestId;
    opened=null;example=false;$('reg-manual').open=false;
    for(const key of Object.keys(fields)){const input=$('reg-field-'+key);if(input.tagName==='SELECT')input.selectedIndex=0;else input.value='';}
    $('reg-mode').value='simulation';
    $('reg-file').value='';$('reg-pdf').value='';$('reg-url').value='';
    detail.replaceChildren();status.textContent='';
    if(!versions.value)return;
    const [contract,revision]=JSON.parse(versions.value);
    const query='?'+new URLSearchParams({contract,revision});
    const record=await api('/api/registry/revision'+query);
    if(serial!==requestId)return;
    opened=record;
    $('reg-url').value=record.source_url;
    add(detail,'strong',modeName(record.mode)+' · '+record.contract_id+' · редакция '+record.revision);
    add(detail,'p','Сохранена '+new Date(record.recorded_at).toLocaleString('ru-RU',{timeZone:'Asia/Kamchatka'})+' (Камчатка) · сеть '+record.network_version);
    if(record.source_url && /^https:\/\//i.test(record.source_url)){
      const source=add(detail,'a','Открыть источник');source.href=record.source_url;source.target='_blank';source.rel='noreferrer';
    }
    if(record.pdf_digest){
      const link=add(detail,'a','Скачать сохранённый PDF');
      link.href='/api/registry/document'+query;
      add(detail,'p','SHA-256: '+record.pdf_digest);
    }
    for(const r of record.rows){
      add(detail,'p',r.line+'. '+(r.mapped?(r.asset_name||'Без названия'):'Геометрия не найдена')+' · '+r.edge_id+' · '+(data.workTypes[r.operation]||r.operation)+' · '+r.date_from+' — '+r.date_until+' (до начала дня)');
      add(detail,'p',r.object_type+' · юрисдикция: '+r.jurisdiction+' · владелец: '+r.owner+' · балансодержатель: '+r.balance_holder);
      add(detail,'p','Заказчик: '+r.customer+' · исполнитель: '+r.executor+' · ответственный: '+r.officer+' · основание: '+r.source+', '+r.clause+' · проверяющий: '+r.reviewer);
    }
    const btn=add(detail,'button','Скачать строки редакции (JSON)','row-button');btn.type='button';
    const schedule={mode:record.mode,networkVersion:record.network_version,rows:record.rows.map(r=>({
      contractId:r.contract_id,edgeId:r.edge_id,objectType:r.object_type,jurisdiction:r.jurisdiction,owner:r.owner,balanceHolder:r.balance_holder,operation:r.operation,customer:r.customer,executor:r.executor,officer:r.officer,
      source:r.source,clause:r.clause,reviewer:r.reviewer,from:r.date_from,until:r.date_until,...(r.worksite?{worksite:r.worksite}:{})}))};
    btn.onclick=()=>downloadOrder(schedule,'scope-revision-'+revision+'.json');
    if(schedule.rows.length===1){
      for(const key of Object.keys(fields))$('reg-field-'+key).value=schedule.rows[0][key]??'';
      $('reg-mode').value=record.mode;
    }
    const mapped=record.rows.find(r=>r.mapped && edges.has(r.edge_id));
    if(record.mode==='simulation' && mapped && record.network_version===data.network.version){
      const use=add(detail,'button','Проверить учебный наряд по редакции','row-button');use.type='button';
      use.onclick=()=>{selectedRegistryRef={contractId:record.contract_id,revision:record.revision,line:mapped.line};registryAttachment=schedule;$('attachment-file').value='';$('order-case').value='attachment';roadMap.focus(mapped.edge_id);openOrder(mapped.edge_id);$('order-operation').value=mapped.operation;refreshOrder();};
    }
  }
  function failure(error){status.textContent=error.message;}
  let loaded=false;
  panel.addEventListener('toggle',()=>{
    if(!panel.open||loaded)return;
    loaded=true;list().catch(error=>{loaded=false;failure(error);});
  });
  versions.onchange=()=>show().catch(failure);
  $('reg-example').onclick=()=>{example=true;$('reg-manual').open=false;$('reg-file').value='';status.textContent='Выбран учебный пример DEMO-01.';};
  $('reg-file').onchange=()=>{example=false;$('reg-manual').open=false;status.textContent='';};
  $('reg-save').onclick=async()=>{
    controls(true);
    try{
      const json=$('reg-file').files[0],pdf=$('reg-pdf').files[0];
      const manual=$('reg-manual').open;
      if(manual && opened?.rows.length>1)throw Error('Для изменения многострочной редакции загрузите полный JSON.');
      if(!manual && !json && !example)throw Error('Выберите JSON или подставьте учебный пример.');
      if(json?.size>256*1024 || pdf?.size>12*1024*1024)throw Error('Допустимо до 256 КиБ JSON и 12 МиБ PDF.');
      const file=manual?{mode:$('reg-mode').value,networkVersion:data.network.version,
        rows:[{...(opened?.rows[0]?.worksite?{worksite:opened.rows[0].worksite}:{}),...Object.fromEntries(Object.keys(fields).map(k=>[k,$('reg-field-'+k).value.trim()]).filter(([,v])=>v))}]}:
        example?sampleAttachment:JSON.parse(await json.text());
      if(versions.value && (!opened || opened.contract_id!==file.rows?.[0]?.contractId))throw Error('Выберите редакцию этого договора или новую запись.');
      const pdfBase64=pdf?await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать PDF'));reader.readAsDataURL(pdf);
      }):undefined;
      const record=await api('/api/registry',{file,pdfBase64,sourceUrl:$('reg-url').value.trim(),baseRevision:opened?.revision??0});
      await list(JSON.stringify([record.contract_id,record.revision]));
      if(roadMap.mode==='coverage')roadMap.onModeChange('coverage');
      status.textContent='Сохранена редакция '+record.revision+'.';
    }catch(error){failure(error);}finally{controls(false);}
  };
}

function initCoverage(){
  if($('registry-panel').hidden)return;
  $('map-mode').add(new Option('Покрытие по реестру · город','coverage'));
  const controls=$('coverage-controls'),status=$('coverage-status'),find=$('coverage-find');
  const day=$('coverage-date'),operation=$('coverage-operation'),source=$('coverage-source'),time=$('coverage-cutoff');
  day.value=$('date').value||initialDate();
  for(const [value,title] of Object.entries(data.workTypes))operation.add(new Option(title,value));
  let sequence=0;
  async function refresh(mode){
    const version=++sequence;
    controls.hidden=mode!=='coverage';
    if(controls.hidden)return;
    roadMap.coverage=null;roadMap.paint(true);roadMap.highlight(null);
    find.replaceChildren();find.hidden=true;
    status.textContent='Загрузка среза…';
    try{
      const params=new URLSearchParams({date:day.value,operation:operation.value,mode:source.value});
      if(time.value)params.set('asOf',new Date(time.value+'+12:00').toISOString());
      const result=await api('/api/registry/coverage?'+params);
      if(version!==sequence)return;
      roadMap.coverage=new Map(result.entries);roadMap.paint(true);
      if(roadMap.selected)showRoad(roadMap.selected);
      const summary=Object.entries({single:'Одна строка',overlap:'Пересечение',unknown:'Без строки'}).map(([key,title])=>{
        const bucket=result.stats[key];
        return title+': '+format(bucket.km,2)+' км ('+bucket.edges+' уч.)';
      });
      status.textContent='Городская дорожная сеть · '+summary.join(' · ')+'. Строк без геометрии: '+result.unmapped.length+'.';
      for(const r of result.unmapped)add(status,'span',' '+r.contract_id+', строка '+r.line+' ('+r.edge_id+').');
      find.add(new Option('Найти участок на карте',''));
      for(const [id,rows] of result.entries)find.add(new Option((edges.get(id)?.name||id)+' · '+rows[0].contract_id+(rows.length>1?' · пересечение':''),id));
      find.hidden=!result.entries.length;
    }catch(error){if(version===sequence)status.textContent='Срез недоступен: '+error.message;}
  }
  find.onchange=()=>{if(find.value)roadMap.focus(find.value);};
  for(const element of [day,operation,source,time])element.onchange=()=>refresh(roadMap.mode);
  roadMap.onModeChange=refresh;
}

function initEquipmentObservations(){
  const {facts,sources}=window.equipmentEvidence;
  const titles={reported_ready_vehicles:'Заявленная готовность техники',reported_snow_storage_sites:'Подготовка снежных площадок',
    prior_snow_storage_sites:'Площадки в предыдущем сравнении',new_machines_delivered_by_2026_09_25:'Прибытие партии машин',
    new_machines_reported_purchased:'Сообщение о закупке',winter_preparation_inspected:'Проверка подготовки к зиме',
    mechanics_reported_prepared:'Подготовка механиков',special_vehicles_for_emergency_table:'Спецмашины в таблице сил ЧС',
    loaders_for_emergency_table:'Погрузчики в таблице сил ЧС',excavators_for_emergency_table:'Экскаваторы в таблице сил ЧС',
    emergency_staff_reported:'Численность формирования',vehicles_working_night:'Выход техники в ночную смену',
    reported_new_categories:'Сообщение о типах новой техники',kamaz_combined_road_machines_reported:'Сообщение о КДМ КамАЗ',
    compact_street_vacuum_sweepers_reported:'Вакуумные подметальные машины',tires_blades_salt_mix_spares_checked:'Проверка запасов',
    blizzard_parking_prepared:'Подготовка стоянки',heavy_tow_truck_duty_requested:'Запрос дежурства тягачей',
    vehicle_towing_near_schools_prioritized:'Эвакуация машин у школ',mechanical_brush_and_pgm_used:'Щётки и обработка покрытия',
    snowbank_blower_and_drain_clearance_used:'Разбор валов и водоотвод',verified_per_vehicle_ids:'Идентифицированные машины в исследовании'};
  const select=$('equipment-observation'),out=$('equipment-source');
  for(const fact of facts)select.add(new Option(fact.observed_date+' · '+titles[fact.field]+' · '+fact.id,fact.id));
  function show(){
    const fact=facts[select.selectedIndex],source=sources[fact.source_id];
    out.replaceChildren();add(out,'strong',titles[fact.field]);
    if(typeof fact.value==='number'){
      const prefix={greater_than:'Более ',approximately:'Около '}[fact.qualifier]??'';
      add(out,'p',prefix+fact.value+' '+({pieces:'ед.',people:'чел.',sites:'площ.',records:'зап.'}[fact.unit]??fact.unit));
    }
    if(Array.isArray(fact.value)){
      const types={grader:'грейдер',combined_road_machine:'комбинированная дорожная машина',snowblower:'снегоочиститель',front_loader:'фронтальный погрузчик',general_purpose_vehicle:'машина общего назначения'};
      add(out,'p',fact.value.map(v=>types[v]??v).join(', '));
    }
    add(out,'p',fact.observed_date+' · '+(fact.scope==='citywide'?'город в целом':fact.entity_id));
    add(out,'p',fact.comment);
    const link=add(out,'a',source.title);link.href=source.url;link.target='_blank';link.rel='noreferrer';
  }
  select.onchange=show;show();
}
initEquipmentObservations();

let workflows, readHaulOptions;
let haulRevision=0;
const haulPoints={};
function clearHaul(){
  workflows?.clearShared();haulRevision++;$('haul-result').replaceChildren();
  if(roadMap)roadMap.showHaul($('haul-travel').value==='network'?haulPoints:{});
}
function initHaul(){
  const fields=[
    ['volume','Снег к вывозу, м³',60,1,1000000],['siteCapacity','Свободная вместимость площадки, м³',60,0,1000000],
    ['loadRate','Производительность погрузчика, м³/ч',60,1,6000],['driveMin','Путь в одну сторону, мин',15,1,1440],
    ['unloadMin','Разгрузка одного рейса, мин',10,1,1440],['siteBusyUntil','Через сколько минут от начала смены освободится пост',0,0,1440]
  ];
  for(const [key,title,value,min,max] of fields){
    const input=add(add($('haul-fields'),'label',title),'input');
    Object.assign(input,{id:'haul-'+key,type:'number',value,min,max,step:1,required:true});
  }
  const form=$('haul-form');form.oninput=clearHaul;
  const travel=$('haul-travel'),mapBox=$('map');
  travel.onchange=()=>{
    const manual=travel.value==='manual';
    $('haul-points').hidden=manual;$('haul-driveMin').disabled=!manual;
    $('haul-driveMin').parentElement.hidden=!manual;
    if(roadMap?.onHaulPick)cancelPick();
    clearHaul();
  };
  const limits=new Map();
  let picked=null;
  function pickMode(message){
    $('pick-banner').hidden=!message;
    $('pick-banner').querySelector('span').textContent=message||'';
  }
  function cancelPick(){
    roadMap.onHaulPick=null;pickMode('');
    for(const key of ['loadNode','siteNode'])$('haul-'+key+'-label').textContent=haulPoints[key]||'Точка не выбрана';
    $('transit-status').textContent='Выбор отменён';
  }
  $('cancel-map-pick').onclick=cancelPick;
  document.addEventListener('sever:leave-haul',()=>{if(roadMap?.onHaulPick)cancelPick();});
  $('map-mode').addEventListener('change',()=>pickMode(''));
  $('transit-pick').onclick=()=>{
    if(!roadMap)return;
    roadMap.setMode('priority');roadMap.highlight(null);
    $('transit-status').textContent='Нажмите на дорогу.';
    pickMode('Выберите участок с ограничением транзита');
    roadMap.onHaulPick=(node,name,id)=>{
      pickMode('');
      roadMap.onHaulPick=null;picked={id,name};
      $('transit-road').textContent=name+' · '+id;
      for(const key of ['maxKg','widthM','gradePct','source'])$('transit-'+key).value=limits.get(id)?.[key]??'';
      $('transit-status').textContent='';
      $('transit-add').scrollIntoView({block:'center'});
    };
    mapBox.scrollIntoView({block:'center'});
  };
  function listLimits(){
    $('limit-count').textContent=limits.size;
    const root=$('transit-list');root.replaceChildren();
    for(const r of limits.values()){
      const row=add(root,'p');
      const values=[r.maxKg!=null?r.maxKg+' кг':'',r.widthM!=null?r.widthM+' м':'',r.gradePct!=null?r.gradePct+' %':''].filter(Boolean);
      add(row,'span',r.name+' · '+values.join(', ')+' · '+r.source+' ');
      const remove=add(row,'button','Снять');remove.type='button';remove.onclick=()=>{limits.delete(r.edgeId);listLimits();clearHaul();};
    }
  }
  $('transit-add').onclick=()=>{
    const source=$('transit-source').value.trim(),rule={};
    for(const key of ['maxKg','widthM','gradePct']){
      const el=$('transit-'+key);if(!el.reportValidity())return;
      if(el.value!=='')rule[key]=el.valueAsNumber;
    }
    if(!picked || !source || !Object.keys(rule).length){$('transit-status').textContent='Выберите участок, укажите основание и хотя бы одно ограничение.';return;}
    limits.set(picked.id,{...rule,edgeId:picked.id,name:picked.name,source});
    $('transit-status').textContent='Ограничение применено.';listLimits();clearHaul();
  };
  for(const key of ['loadNode','siteNode']){
    $('haul-'+key).onclick=()=>{
      if(!roadMap)return;
      roadMap.setMode('priority');roadMap.highlight(null);
      $('haul-'+key+'-label').textContent='Нажмите дорогу на карте';
      pickMode(key==='loadNode'?'Выберите дорогу у точки погрузки':'Выберите дорогу у площадки разгрузки');
      roadMap.onHaulPick=(node,name)=>{
        pickMode('');
        roadMap.onHaulPick=null;haulPoints[key]=node;
        $('haul-'+key+'-label').textContent=name+' · узел '+node;
        clearHaul();$('haul-form').scrollIntoView({block:'center'});
      };
      mapBox.scrollIntoView({block:'center'});
    };
  }
  readHaulOptions=()=>{
    const options={fleetMode:$('haul-fleet').value,sitePermitted:$('haul-permit').checked};
    const density=$('haul-density');
    if(density.value!=='')options.densityKgM3=density.valueAsNumber;
    Object.assign(options,{travelMode:travel.value},travel.value==='network'?haulPoints:{});
    if(travel.value==='network')options.transitLimits=[...limits.values()];
    for(const [key] of fields)options[key]=$('haul-'+key).valueAsNumber;
    return options;
  };
  form.onsubmit=async e=>{
    e.preventDefault();clearHaul();
    const revision=haulRevision,out=$('haul-result');
    if(!plan){add(out,'p','Сначала рассчитайте смену.');return;}
    const options=readHaulOptions();
    try{
      const result=await api('/api/haul/preview',{shift:plan.input,options});
      if(revision!==haulRevision)return;
      add(out,'strong','Вывоз по плану: '+result.delivered+' м³ · остаток '+result.remaining+' м³ · '+money(result.cost));
      add(out,'p',result.totalCargoKg===null?'Плотность не задана. Масса груза не проверена.':'Расчётная масса вывоза: '+format(result.totalCargoKg,0)+' кг при '+format(result.densityKgM3,0)+' кг/м³.');
      for(const vehicle of result.excluded)add(out,'p',vehicle.name+' · '+vehicle.reason);
      if(result.paths){
        let shown=result.paths;
        if(result.routeSets?.length>1){
          const select=add(add(out,'label','Маршрут рейса'),'select');
          result.trips.forEach((t,i)=>select.add(new Option((i+1)+' · '+t.truck+' · '+t.amount+' м³',t.routeIndex)));
          select.onchange=()=>{shown=result.routeSets[Number(select.value)];drawDirections();};
        }
        const directions=add(out,'div');
        function drawDirections(){directions.replaceChildren();
        for(const [direction,label] of [['outward','Туда'],['home','Обратно']]){
          const path=shown[direction];
          if(!path){add(directions,'p',label+' · путь отсутствует');continue;}
          const btn=add(directions,'button',label+' · '+format(path.km,2)+' км · показать на карте','row-button');btn.type='button';
          btn.onclick=()=>{roadMap.setMode('priority');roadMap.showHaul(haulPoints,shown,direction);mapBox.scrollIntoView({block:'center'});};
        }
        roadMap.showHaul(haulPoints,shown,'outward');
        }
        drawDirections();
      }
      if(result.reason)add(out,'p',result.reason);
      if(!result.trips.length)return;
      add(out,'p',result.loader+' · время Камчатки. В стоимости учтены погрузка и занятость самосвала от начала погрузки до возврата, включая ожидание.');
      const body=table(out,['Самосвал','м³','Груз, кг','Погрузка','Прибытие','Очередь, мин','Разгрузка','Возврат','Стоимость']);
      for(const t of result.trips){
        const row=add(body,'tr');
        for(const v of [t.truck,t.amount,t.cargoKg??'—',clock(t.start)+'–'+clock(t.depart),clock(t.arrive),t.wait,clock(t.unload)+'–'+clock(t.finish),clock(t.back),money(t.cents/100)])add(row,'td',String(v));
      }
    }catch(error){if(revision===haulRevision)add(out,'p',error.message);}
  };
}
initHaul();

workflows=initWorkflows({
  api,add,table,getPlan:()=>plan,getHaul:()=>readHaulOptions(),
  showEdge:locate,
  showHaulMap:(points,paths)=>{
    if(!$('map').getClientRects().length)navigateDashboard('haul');
    roadMap.setMode('priority');
    if(paths.outward?.edges.length)roadMap.focus(String(paths.outward.edges[0]));
    roadMap.showHaul(points,paths,'outward');
    $('map').scrollIntoView({block:'center'});
  },
  edgeName:id=>roadOptions.get(String(id))||edges.get(String(id))?.name||('Участок '+id),
  getPickedPass:()=>orderEdge?'pass:'+orderEdge+':'+$('order-direction').value:null,
  getOrder:()=>{
    if(!orderEdge || !plan)return null;
    const scenario=$('order-case').value;
    if(scenario!=='example' && scenario!=='attachment')throw Error('Выберите учебный образец или сохранённую редакцию реестра.');
    if(scenario==='attachment' && (!selectedRegistryRef || $('attachment-file').files.length || !registryAttachment))
      throw Error('Для серверного наряда откройте сохранённую учебную редакцию в реестре.');
    if(['limit-width','limit-mass','limit-grade'].some(id=>$(id).value!==''))
      throw Error('Локальные ограничения карточки действуют в её предпросмотре. Для серверного наряда используйте ограничения строки реестра.');
    return {vehicleId:$('order-vehicle').value,edgeId:orderEdge,operation:$('order-operation').value,
      reverse:$('order-direction').value==='r',...(scenario==='attachment'?{registryRef:selectedRegistryRef}:{})};
  }
});
