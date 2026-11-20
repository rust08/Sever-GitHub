// Backend-backed controls for the dashboard. All displayed state comes from a saved
// shift or an explicit simulation request. Changing views does not replace a draft.
export function initWorkflows({api, add, table, getPlan, getOrder, getHaul, edgeName, getPickedPass, showEdge, showHaulMap}) {
  const byId=id=>document.getElementById(id);
  const rub=cents=>(cents/100).toLocaleString('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
  const time=stamp=>new Date(stamp).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kamchatka'});
  const local=!globalThis.severDemo && ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const demo=byId('demo-workflow'), journal=byId('journal-workflow'), shared=byId('shared-workflow');
  const button=(box,title,fn)=>{
    const el=add(box,'button',title,'row-button');
    el.type='button';el.addEventListener('click',fn);return el;
  };
  const select=(parent,label,options)=>{
    const el=add(add(parent,'label',label),'select');
    el.replaceChildren(...options.map(([value,title])=>new Option(title,value)));return el;
  };
  const number=(parent,label,value,min,max)=>{
    const el=add(add(parent,'label',label),'input');
    Object.assign(el,{type:'number',value,min,max,step:1,required:true});return el;
  };
  const alert=parent=>{
    const box=add(parent,'p',null,'workflow-status');box.setAttribute('role','status');return box;
  };
  const row=(body,values)=>{
    const tr=add(body,'tr');
    for(const value of values)add(tr,'td',value);
    return tr;
  };
  const subtitle=(root,title)=>add(root,'h3',title);
  function action(box,title,state,fn){
    return button(box,title,async e=>{
      const el=e.currentTarget; el.disabled=true;state.textContent='Выполняется запрос…';
      try{await fn();if(state.textContent==='Выполняется запрос…')state.textContent='';}
      catch(error){state.textContent=error.message||'Проверьте подключение и повторите действие.';}
      finally{el.disabled=false;}
    });
  }
  const kinds={plow:'Расчистка',drive:'Переезд',load:'Погрузка',loading:'Под погрузкой',loaded_drive:'Вывоз',wait:'Ожидание',unload:'Разгрузка',return:'Возврат',prior_booking:'Занят до смены'};
  function schedule(parent,p,fleet){
    const names=new Map((fleet??[]).map(v=>[v.id,v.name]));
    const box=add(parent,'details');add(box,'summary','Расписание ресурсов · '+p.reservations.length+' интервалов');
    const sorted=[...p.reservations].sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end));
    const pageSize=30;
    let page=0;
    const controls=add(box,'div',null,'workflow-actions'),prev=button(controls,'Назад',()=>{page--;draw();});
    const counter=add(controls,'span');const next=button(controls,'Далее',()=>{page++;draw();});
    const body=table(box,['Время на Камчатке','Ресурс','Операция','Участок / рейс']);
    function draw(){
      const start=page*pageSize;body.replaceChildren();
      for(const s of sorted.slice(start,start+pageSize)){
        const tr=row(body,[time(s.start)+'–'+time(s.end),s.resourceType==='machine'?(names.get(s.resourceId)||s.resourceId):'Разгрузочный пост',
        kinds[s.kind]??s.kind,s.edgeId?'':s.trip?'Рейс '+s.trip:'—']);
        if(s.edgeId)button(tr.lastElementChild,edgeName(s.edgeId),()=>showEdge(s.edgeId));
      }
      prev.disabled=!page;next.disabled=start+pageSize>=sorted.length;
      counter.textContent=sorted.length?(start+1)+'–'+Math.min(start+pageSize,sorted.length)+' из '+sorted.length:'Интервалы отсутствуют';
    }
    draw();
  }
  function summary(root,p,fleet,options){
    const metrics=add(root,'div',null,'workflow-facts');
    for(const [label,val] of [['Назначено проходов',p.clearing.summary.assigned+' / '+p.clearing.summary.total],
      ['Вывоз',p.haul.delivered+' м³'],['Расходы',rub(p.spentCents)],['Остаток бюджета',rub(p.remainingCents)]]){
      const card=add(metrics,'div');add(card,'small',label);add(card,'strong',val);
    }
    if(p.haul.remaining)add(root,'p','Осталось вывезти '+p.haul.remaining+' м³. '+(p.haul.reason||'Проверьте ресурсы смены.'));
    if(p.haul.trips.length){
      const t=p.haul.trips[0],paths=p.haul.routeSets[t.routeIndex]??p.haul.paths;
      if(paths)button(root,'Показать путь первого рейса',()=>showHaulMap(options,paths));
    }
    schedule(root,p,fleet);
  }
  let sharedRevision=0;
  subtitle(shared,'Общий план расчистки и вывоза');
  add(shared,'p','Один парк и бюджет сохранённой смены. Выберите парк смены, городской маршрут, два узла и плотность снега.');
  const sharedStatus=alert(shared),sharedOut=add(shared,'div');
  action(shared,'Рассчитать общий план',sharedStatus,async()=>{
    const shift=getPlan()?.input;
    if(!shift)throw Error('Сначала рассчитайте план смены.');
    if(!byId('haul-form').reportValidity())throw Error('Проверьте выделенные поля снеговывоза.');
    const options=getHaul();
    const seq=++sharedRevision;
    const p=await api('/api/unified-shifts/preview',{shift,options});
    if(seq!==sharedRevision || getPlan()?.input!==shift)return;
    sharedOut.replaceChildren();summary(sharedOut,p,shift.fleet,options);
  });
  function clearShared(){
    sharedRevision++; sharedOut.replaceChildren(); sharedStatus.textContent='';
  }

  const states={created:'Создан',issued:'Выдан',started:'Работа начата',reported:'Отчёт исполнителя',inspected:'Осмотрен',accepted:'Принят',cancelled:'Отменён',needs_rework:'На доработке',rejected:'Отклонён',disputed:'Оспорен'};
  const verbs={issued:'Выдать',started:'Начать работу',reported:'Подать отчёт',inspected:'Зарегистрировать осмотр',accepted:'Принять',cancelled:'Отменить наряд',needs_rework:'Вернуть на доработку',rejected:'Отклонить',disputed:'Оспорить решение'};
  const roles={dispatcher:'Диспетчер',executor:'Исполнитель',inspector:'Инспектор',customer:'Заказчик'};
  const colors={created:'draft',issued:'draft',started:'active',reported:'active',inspected:'active',accepted:'done',cancelled:'blocked',needs_rework:'blocked',rejected:'blocked',disputed:'blocked'};

  subtitle(journal,'Журнал нарядов');subtitle(demo,'Сценарии снегопада');
  if(!local){
    for(const root of [journal,demo])add(root,'p','Сохранение редакций и событий доступно в локальном сервере. Откройте диспетчерскую через npm start.');
    return {clearShared,planChanged(){}};
  }
  const demoStatus=alert(demo),demoBar=add(demo,'div',null,'workflow-actions');
  const preset=select(demoBar,'Сценарий',[['normal','Обычная смена'],['heavy','Сильный снегопад']]);
  const demoOut=add(demo,'div');
  let report,epoch=0;
  const key='sever-ui-demo-shift-v1';
  function remember(id){try{sessionStorage.setItem(key,id);}catch{}}
  async function loadReport(id,revision,seq){
    const p=await api('/api/demo-shifts/'+encodeURIComponent(id)+(revision?'?revision='+revision:''));
    if(seq!==epoch)return;
    report=p;remember(id);renderDemo();
  }
  action(demoBar,'Запустить пример снегопада',demoStatus,async()=>{
    const seq=++epoch;
    const saved=await api('/api/demo-shifts',{scenario:preset.value});
    await loadReport(saved.id,saved.revision,seq);
  });
  function renderDemo(){
    const p=report;
    demoOut.replaceChildren();
    add(demoOut,'h4',p.title+' · редакция '+p.revision);
    add(demoOut,'p','Отдельная учебная смена · '+p.input.shift.date+' · '+time(p.plan.windowStart)+'–'+time(p.plan.windowEnd)+' (Камчатка)');
    summary(demoOut,p.plan,p.input.shift.fleet,p.input.options);
    const bar=add(demoOut,'div',null,'workflow-actions');
    const link=add(bar,'a','Скачать отчёт JSON','row-button');link.href='/api/demo-shifts/'+p.id+'/export?revision='+p.revision;link.download='';
    const editor=add(demoOut,'details');add(editor,'summary','Повторный снегопад');
    const lastMinute=p.events.at(-1)?.minute??-1,min=lastMinute+1,max=p.input.shift.shiftMin-1;
    if(min<=max){
      const when=number(editor,'Минута от начала смены',Math.min(max,Math.max(2,min)),min,max);
      const amount=number(editor,'Дополнительный снег, м³',15,1,1000000);
      const repeat=select(editor,'Повторный проход',[['','Только вывоз'],['selected','Выбранное направление на карте']]);
      action(editor,'Пересчитать оставшиеся работы',demoStatus,async()=>{
        if(!when.reportValidity()||!amount.reportValidity())throw Error('Уточните время события и объём.');
        const body={expectedRevision:p.revision,minute:when.valueAsNumber,addedM3:amount.valueAsNumber};
        if(repeat.value){const id=getPickedPass();if(!id)throw Error('Выберите участок карты и направление в карточке наряда.');body.repeatPassIds=[id];}
        const seq=++epoch;
        const saved=await api('/api/demo-shifts/'+p.id+'/snowfall',body);
        await loadReport(saved.id,saved.revision,seq);
      });
    }else add(editor,'p','До конца этой смены нет свободной минуты для нового события.');
    const comparison=add(demoOut,'div');
    if(p.revision>1)action(bar,'Сравнить с предыдущей редакцией',demoStatus,async()=>{
      const prev=await api('/api/demo-shifts/'+p.id+'?revision='+(p.revision-1));
      if(report!==p)return;
      comparison.replaceChildren();
      const body=table(comparison,['Показатель','Ред. '+prev.revision,'Ред. '+p.revision]);
      row(body,['Расходы, ₽',rub(prev.plan.spentCents),rub(p.plan.spentCents)]);
      row(body,['План вывоза, м³',prev.plan.haul.delivered,p.plan.haul.delivered]);
      row(body,['Назначено проходов',prev.plan.clearing.summary.assigned,p.plan.clearing.summary.assigned]);
    });
    action(bar,'Обновить редакцию',demoStatus,()=>loadReport(p.id,null,++epoch));
  }
  try{
    const saved=sessionStorage.getItem(key);
    if(saved)loadReport(saved,null,++epoch).catch(()=>{demoStatus.textContent='Сохранённый пример недоступен. Запустите новый сценарий.';});
  }catch{}
  add(journal,'p','Демонстрационный режим ролей · учебные записи сохраняются на этом компьютере.');
  const journalStatus=alert(journal);
  const createBar=add(journal,'div',null,'workflow-actions');
  const taskSelect=select(createBar,'Основание для учебного наряда',[['selected','Участок из карточки дороги']]);
  const role=select(createBar,'Демо-роль',Object.entries(roles));
  const listBar=add(journal,'div',null,'workflow-actions');
  const filter=select(listBar,'Статус',[['','Все статусы'],...Object.entries(states)]);
  const operationFilter=select(listBar,'Операция',[['','Все операции']]);
  const executorFilter=select(listBar,'Исполнитель',[['','Все исполнители']]);
  const dateFilter=add(add(listBar,'label','Дата смены'),'input');dateFilter.type='date';
  const records=new Map();
  const list=add(journal,'div'),detail=add(journal,'div');
  let orders=[],opened=null,shiftId=null,listEpoch=0,openEpoch=0,requests=new Map(),errorLoading=false;
  async function serverPost(path,body,who){
    const signature=JSON.stringify([path,body,who]);
    if(!requests.has(signature))requests.set(signature,crypto.randomUUID());
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Simulation-Role':who,
      'Idempotency-Key':requests.get(signature)},body:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok)throw Error((result.error||'Сервер отклонил запрос.')+(response.status===409?' Обновите журнал.':''));
    requests.delete(signature);
    return result;
  }
  async function refreshList(){
    const id=getPlan()?.id,seq=++listEpoch;
    if(!id)return;
    try{
      const result=await api('/api/work-orders?shiftId='+encodeURIComponent(id));
      if(id!==getPlan()?.id||seq!==listEpoch)return;
      const missing=result.orders.filter(o=>!records.has(o.id));
      // The list API returns IDs and status. Fetch immutable snapshots once to label the rows.
      const received=new Map();
      for(let i=0;i<missing.length;i+=8){
        const values=await Promise.all(missing.slice(i,i+8).map(o=>api('/api/work-orders/'+o.id)));
        if(id!==getPlan()?.id||seq!==listEpoch)return;
        values.forEach(o=>received.set(o.id,o.snapshot));
      }
      received.forEach((snapshot,id)=>records.set(id,snapshot));
      orders=result.orders;errorLoading=false;
      const updateOptions=(select,label,entries)=>{
        const selected=select.value;select.replaceChildren(new Option(label,''));
        for(const value of [...new Set(entries)].sort())select.add(new Option(value,value));
        if([...select.options].some(o=>o.value===selected))select.value=selected;
      };
      updateOptions(operationFilter,'Все операции',orders.map(o=>operationName(records.get(o.id))));
      updateOptions(executorFilter,'Все исполнители',orders.map(o=>executorName(records.get(o.id))));
      drawList();
    }catch(error){
      if(id!==getPlan()?.id||seq!==listEpoch)return;
      errorLoading=true;drawList();throw error;
    }
  }
  const operationName=s=>s.operation==='patrol_plow'?'Патрульная расчистка':s.operation;
  const executorName=s=>s.contract?.executor??'Учебный подрядчик';
  const shiftDay=s=>new Date(Date.parse(s.shiftStart)+12*3600000).toISOString().slice(0,10);
  function drawList(){
    list.replaceChildren();
    if(errorLoading){add(list,'p','Не удалось получить список. Нажмите «Обновить журнал».');return;}
    const filtered=orders.filter(o=>{
      const s=records.get(o.id);
      return (!filter.value||o.status===filter.value) && (!operationFilter.value||operationName(s)===operationFilter.value) &&
        (!executorFilter.value||executorName(s)===executorFilter.value) && (!dateFilter.value||shiftDay(s)===dateFilter.value);
    });
    if(!filtered.length){add(list,'p',orders.length?'По этим фильтрам в сохранённой смене нарядов нет.':'Нарядов пока нет. Выберите проход сохранённой смены и создайте учебный наряд.');return;}
    const body=table(list,['Наряд','Участок','Статус','Исполнитель','Редакция']);
    for(const item of filtered){
      const tr=add(body,'tr'),cell=add(tr,'td');
      action(cell,'№ '+item.id.slice(0,8),journalStatus,()=>loadOrder(item.id));
      const snapshot=records.get(item.id);add(tr,'td',edgeName(snapshot.edgeId));
      add(add(tr,'td'),'span',states[item.status]??item.status,'workflow-state '+colors[item.status]);add(tr,'td',executorName(snapshot));add(tr,'td',item.version);
    }
  }
  for(const field of [filter,operationFilter,executorFilter,dateFilter])field.onchange=drawList;
  async function loadOrder(id){
    const seq=++openEpoch,shift=getPlan()?.id;
    const value=await api('/api/work-orders/'+id);
    if(seq!==openEpoch || shift!==getPlan()?.id)return;
    opened=value;drawOrder();
  }
  function drawOrder(){
    detail.replaceChildren();const o=opened;
    if(!o)return;
    const snap=o.snapshot, fleet=getPlan()?.input?.fleet??[],vehicle=fleet.find(v=>v.id===snap.vehicleId);
    add(detail,'h4','Наряд № '+o.id.slice(0,8)+' · '+states[o.status]);
    add(detail,'p',edgeName(snap.edgeId)+' · '+(snap.reverse?'обратное':'прямое')+' направление · патрульная расчистка');
    add(detail,'p',(vehicle?.name??snap.vehicleId)+' · '+(snap.contract?.executor??'Учебный подрядчик')+' · '+snap.basis);
    const history=add(detail,'ol',null,'workflow-history');
    for(const ev of o.events){
      const item=add(history,'li');
      add(item,'strong',states[ev.event_type]+' · '+roles[ev.role]);
      add(item,'small',new Date(ev.occurred_at).toLocaleString('ru-RU',{timeZone:'Asia/Kamchatka'})+' · '+ev.comment);
    }
    const next=Object.entries(o.next);
    if(!next.length)return;
    const allowed=next.filter(([,required])=>required===role.value);
    if(!allowed.length){add(detail,'p','Следующее действие выполняет: '+[...new Set(next.map(([,r])=>roles[r]))].join(' или ')+'. Выберите демо-роль.');return;}
    const form=add(detail,'div',null,'workflow-actions');
    const comment=add(add(form,'label','Комментарий к событию'),'input');comment.maxLength=1000;comment.required=true;
    const lastMs=Date.parse(o.events.at(-1).occurred_at);
    const timeInput=add(add(form,'label','Время события на Камчатке'),'input');
    timeInput.type='datetime-local';timeInput.step=1;timeInput.required=true;
    const localStamp=ms=>new Date(ms+12*3600000).toISOString().slice(0,19);
    const minimum=Math.ceil(lastMs/1000)*1000;
    timeInput.min=localStamp(minimum);timeInput.value=localStamp(minimum+60000);
    for(const [type] of allowed)action(form,verbs[type],journalStatus,async()=>{
      if(!comment.reportValidity()||!timeInput.reportValidity())throw Error('Проверьте время и оставьте комментарий.');
      const body={expected_version:o.version,event_type:type,comment:comment.value.trim(),occurred_at:new Date(timeInput.value+'+12:00').toISOString()};
      if(!body.comment)throw Error('Добавьте комментарий к событию.');
      const updated=await serverPost('/api/work-orders/'+o.id+'/events',body,role.value);
      if(shiftId!==updated.shiftId)return;
      opened=updated;drawOrder();await refreshList();
    });
  }
  role.onchange=drawOrder;
  action(createBar,'Создать учебный наряд',journalStatus,async()=>{
    if(role.value!=='dispatcher')throw Error('Для создания выберите демо-роль диспетчера.');
    const plan=getPlan();
    if(!plan)throw Error('Сначала рассчитайте смену.');
    const body=taskSelect.value==='selected'?getOrder():JSON.parse(taskSelect.value);
    if(!body)throw Error('Откройте участок из карты или выберите назначенный проход.');
    const value=await serverPost('/api/work-orders',{...body,shiftId:plan.id},role.value);
    if(plan.id!==getPlan()?.id)return;
    for(const field of [filter,operationFilter,executorFilter,dateFilter])field.value='';opened=value;drawOrder();await refreshList();
  });
  action(listBar,'Обновить журнал',journalStatus,async()=>{
    await refreshList();if(opened)await loadOrder(opened.id);
  });
  function planChanged(){
    clearShared();
    const p=getPlan();
    if(!p || shiftId===p.id)return;
    shiftId=p.id;opened=null;requests.clear();records.clear();dateFilter.value='';detail.replaceChildren();orders=[];list.replaceChildren();errorLoading=false;
    taskSelect.replaceChildren(new Option('Участок из карточки дороги','selected'));
    for(const route of p.result.routes){
      const group=document.createElement('optgroup');group.label=route.name;
      for(const leg of route.legs.filter(l=>l.type==='work')){
        const reverse=leg.taskId.endsWith(':r');
        const body={vehicleId:route.vehicleId,edgeId:leg.edgeId,operation:'patrol_plow',reverse};
        group.append(new Option(edgeName(leg.edgeId)+' · '+(reverse?'обратно':'прямо')+' · '+Math.floor(leg.startMin)+' мин',JSON.stringify(body)));
      }
      if(group.childElementCount)taskSelect.append(group);
    }
    if(taskSelect.options.length>1)taskSelect.selectedIndex=1;
    refreshList().catch(error=>{journalStatus.textContent=error.message;});
  }
  return {planChanged,clearShared,orderSelected(){taskSelect.value='selected';}};
}
