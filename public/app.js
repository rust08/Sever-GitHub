import { RoadMap } from './map.js';

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
  $('save-state').textContent = 'Изменения ожидают расчёта. Маршруты и времена относятся к сохранённому плану.';
}
function addVehicle(vehicle, active, open=false) {
  const row = add($('fleet'),'div',null,'fleet-item');
  row.dataset.id=vehicle.id;
  const head=add(row,'label',null,'pick');
  const enabled=add(head,'input'); enabled.type='checkbox'; enabled.value=vehicle.id; enabled.checked=active;
  const caption=add(head,'span',vehicle.name); enabled.setAttribute('aria-label','Включить в смену: '+vehicle.name);
  const editor=add(row,'details');editor.open=open;add(editor,'summary','Характеристики');
  const fields=add(editor,'div',null,'fleet-fields');
  for(const [key,label] of Object.entries({name:'Название',type:'Тип техники',rate:'Тариф, ₽/ч',workKmh:'Расчистка, км/ч',driveKmh:'Переезд, км/ч'})){
    const field=add(add(fields,'label',label),'input');
    field.dataset.field=key;field.required=true;
    if(key==='name'||key==='type'){
      field.type='text';field.maxLength=120;
      field.value=vehicle[key] || (key==='type'?'Снегоуборочная машина':'');
    }else{
      field.type='number';field.min=key==='rate'?'0.01':'0';field.max=key==='rate'?'1000000':'200';field.step='any';field.value=vehicle[key];
    }
    field.addEventListener('invalid',()=>{editor.open=true;});
    if(key==='name')field.oninput=()=>{
      caption.textContent=field.value||'Машина';enabled.setAttribute('aria-label','Включить в смену: '+caption.textContent);
    };
  }
  const remove=add(editor,'button','Удалить из парка','row-button');remove.type='button';
  remove.onclick=()=>{row.remove();markChanged();$('add-vehicle').focus();};
  return row;
}
function populate(input) {
  $('date').value = input?.date || initialDate();
  $('start').value = input?.start || '08:00';
  $('duration').value = input?.shiftMin ?? 240;
  $('budget').value = input?.budget ?? 30000;
  $('strategy').value = input?.strategy ?? 'parallel';
  $('fleet').replaceChildren();
  for (const vehicle of input?.fleet ?? data.fleet) {
    addVehicle({...vehicle,rate:input?.rates?.[vehicle.id] ?? vehicle.rate},input ? input.vehicleIds.includes(vehicle.id) : true);
  }
  closedRoads = new Set((input?.closed || []).map(String).filter(id=>edges.has(id)));
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
  orderEdge=edgeId;
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
let registryAttachment=null;
const sampleAttachment={mode:'simulation',networkVersion:'pkgo-27233df581c6',rows:[sampleRow,{...sampleRow,edgeId:'unmapped-demo',clause:'Строка 2'}]};
$('attachment-save').onclick=()=>downloadOrder(sampleAttachment,'sever-training-scope.json');
$('attachment-show').onclick=()=>{registryAttachment=null;$('attachment-file').value='';roadMap?.focus(sampleRow.edgeId);openOrder(sampleRow.edgeId);};
async function refreshOrder(action){
  if(orderEdge==null || !plan)return;
  const revision=++orderRevision;
  const offset=$('order-offset'), vehicle=$('order-vehicle');
  offset.disabled=!$('order-event').checked;
  const root=$('order-output');root.replaceChildren();
  if(!offset.disabled && (!offset.value || !offset.checkValidity())){
    root.textContent='Введите целое число минут от 0 до '+plan.input.shiftMin+'.';return;
  }
  const body={vehicleId:vehicle.value,eventOffsetMin:offset.disabled?0:offset.valueAsNumber,shift:plan.input,shiftId:plan.id,edgeId:orderEdge,operation:$('order-operation').value,
    scenario:$('order-case').value,reverse:$('order-direction').value==='r',withEvent:$('order-event').checked};
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
    if(result.event)add(root,'p','Снегопад закончился '+localTime(result.event.at)+' (учебное событие, Камчатка).');
    const clock=result.clock;
    add(root,'p',clock.dueAt?'Учебный срок: '+new Date(clock.dueAt).toLocaleString('ru-RU',{timeZone:'Asia/Kamchatka'})+' (Камчатка), основание: '+result.rule.clause:
      clock.status==='clock_unknown'?'Срок неизвестен: отсутствует подтверждённое начальное событие.':'Срок неизвестен: требуется проверка применимости правила.');
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
  const checked = id => [...$(id).querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
  const fleet=[...$('fleet').children].map(row=>{
    const vehicle={id:row.dataset.id};
    for(const el of row.querySelectorAll('[data-field]'))vehicle[el.dataset.field]=el.type==='number'?el.valueAsNumber:el.value.trim();
    return vehicle;
  });
  const rates=Object.fromEntries(fleet.map(v=>[v.id,v.rate]));
  return {date:$('date').value,start:$('start').value,shiftMin:$('duration').valueAsNumber,budget:$('budget').valueAsNumber,
    vehicleIds:checked('fleet'),closed:[...closedRoads].map(id => edges.get(id).id),
    incidents:[...incidentIds].filter(id=>callOptions.has(id)).map(id=>callOptions.get(id).id),rates,fleet,strategy:$('strategy').value};
}
async function calculate() {
  if (saving || !$('settings').reportValidity()) return;
  const input = readInput();
  if (!input.vehicleIds.length) { $('status').textContent = 'Выберите хотя бы одну машину.'; return; }
  saving = true;
  $('settings').inert = true;
  $('submit').disabled = true;
  $('status').textContent = 'Строим маршруты и проверяем ограничения…';
  try {
    const response = await api('/api/plans',input);
    renderPlan(response);
    $('status').textContent = '';
  } catch (error) { $('status').textContent = 'Расчёт не выполнен. ' + error.message; }
  finally {saving = false; $('settings').inert = false; $('submit').disabled = false;if(roadMap?.selected!=null)showRoad(roadMap.selected);}
}
function renderPlan(next) {
  plan = next;
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
  const selected = $('filter').value;
  $('filter').replaceChildren(new Option('Все машины',''), ...plan.result.routes.map(r => new Option(r.name,r.vehicleId)));
  if (plan.result.routes.some(r => String(r.vehicleId) === selected)) $('filter').value = selected;
  $('minute').max = plan.input.shiftMin;
  $('minute').value = 0;
  $('time-start').textContent = clock(0); $('time-end').textContent = clock(plan.input.shiftMin);
  $('map-count').textContent = data.network.edges.length + ' дорожных участков · ' + plan.result.routes.length + ' маш. в смене';
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
  $('filter').value = route.vehicleId;
  $('minute').value = leg.startMin;
  refreshMap(); roadMap.focus(leg.edgeId);
  $('map').scrollIntoView({block:'center',behavior:'smooth'});
}
function drawRoutes() {
  const root = $('routes'); root.replaceChildren();
  add(root,'p','Местное время. Выберите этап, чтобы увидеть участок и машину на карте.','sub');
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
    const row = add(body,'tr');add(row,'td',task?.name || item.taskId);add(row,'td','P'+(task?.priority || '—'));add(row,'td',item.reason);
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
$('jump-routes').addEventListener('click', () => document.querySelector('[data-page=routes]').click());
$('settings').addEventListener('submit',e => {e.preventDefault(); calculate();});
$('settings').addEventListener('input',e => {
  if (e.target.type === 'search') return;
  markChanged();
});
$('add-vehicle').onclick=()=>{
  const row=addVehicle({id:'v-'+crypto.randomUUID(),name:'Машина '+($('fleet').children.length+1),type:'Снегоуборочная машина',rate:4000,workKmh:8,driveKmh:20},true,true);
  row.querySelector('[data-field=name]').select();markChanged();
};
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
      source:r.source,clause:r.clause,reviewer:r.reviewer,from:r.date_from,until:r.date_until}))};
    btn.onclick=()=>downloadOrder(schedule,'scope-revision-'+revision+'.json');
    if(schedule.rows.length===1){
      for(const key of Object.keys(fields))$('reg-field-'+key).value=schedule.rows[0][key]??'';
      $('reg-mode').value=record.mode;
    }
    const mapped=record.rows.find(r=>r.mapped && edges.has(r.edge_id));
    if(record.mode==='simulation' && mapped && record.network_version===data.network.version){
      const use=add(detail,'button','Проверить учебный наряд по редакции','row-button');use.type='button';
      use.onclick=()=>{registryAttachment=schedule;$('attachment-file').value='';$('order-case').value='attachment';roadMap.focus(mapped.edge_id);openOrder(mapped.edge_id);$('order-operation').value=mapped.operation;refreshOrder();};
    }
  }
  function failure(error){status.textContent=error.message;}
  panel.addEventListener('toggle',()=>{if(panel.open)list().catch(failure);});
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
        rows:[Object.fromEntries(Object.keys(fields).map(k=>[k,$('reg-field-'+k).value.trim()]).filter(([,v])=>v))]}:
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
