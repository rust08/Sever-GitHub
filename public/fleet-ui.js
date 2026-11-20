// This model is independent of visible rows. Filtering and paging must never change a shift.
export function createFleetModel(vehicles, selectedIds, rates={}) {
  const selected=new Set(selectedIds);
  const entries=new Map(vehicles.map(v=>[v.id,{
    vehicle:{...v, type:v.type||'Снегоуборочная машина', rate:Object.hasOwn(rates,v.id)?rates[v.id]:v.rate,
      availability:v.availability??'demo',operations:[...(v.operations??['patrol_plow'])]},
    active:selected.has(v.id)
  }]));
  return {
    entries,
    serialize(){
      const rows=[...entries.values()];
      const fleet=rows.map(({vehicle})=>({...vehicle,operations:[...vehicle.operations]}));
      return {fleet,vehicleIds:rows.filter(row=>row.active).map(row=>row.vehicle.id),
        rates:Object.fromEntries(fleet.map(v=>[v.id,v.rate]))};
    }
  };
}

export function createFleetEditor(root, addButton, workTypes, onChange, getShift) {
  const availabilityNames={demo:'Учебный парк',reported:'На указанный период',unknown:'Доступность неизвестна',unavailable:'Недоступна в смене'};
  const pageSize=15;
  let model=createFleetModel([],[]), page=0;
  function node(tag,parent,text,cls) {
    const el=document.createElement(tag);
    if(text!==undefined)el.textContent=text;
    if(cls)el.className=cls;
    parent?.append(el);return el;
  }
  function button(parent,title,act,cls='row-button'){
    const el=node('button',parent,title,cls);el.type='button';el.onclick=act;return el;
  }
  function labeled(parent,title,tag){
    const label=node('label',parent,title);
    return node(tag,label);
  }
  function options(select,choices) {
    for(const [value,label] of Object.entries(choices))select.add(new Option(label,value));
  }
  const tools=node('div',null,undefined,'fleet-tools');
  const search=labeled(tools,'Поиск техники','input');
  search.type='search';search.placeholder='Название или тип';
  const availability=labeled(tools,'Доступность','select');
  options(availability,{'':'Все статусы',...availabilityNames});
  const operation=labeled(tools,'Вид работы','select');
  options(operation,{'':'Все операции',...workTypes});
  const sort=labeled(tools,'Сортировка','select');
  options(sort,{added:'По добавлению',name:'По названию',rate:'По тарифу'});
  const actions=node('div',null,undefined,'fleet-actions');
  const counter=node('span',actions,undefined,'fleet-counter');
  counter.setAttribute('aria-live','polite');
  const bulk=button(actions,'Включить найденные',()=>toggleFiltered(true));
  const clear=button(actions,'Исключить найденные',()=>toggleFiltered(false));
  actions.append(addButton);
  root.before(tools,actions);
  const viewport=node('div',root,undefined,'fleet-viewport');
  const table=node('table',viewport,undefined,'fleet-grid');
  table.setAttribute('aria-label','Парк смены');
  const header=node('tr',node('thead',table));
  for(const title of ['В смене','Машина','Виды работ','Доступность','Характеристики','Действие'])node('th',header,title).scope='col';
  const body=node('tbody',table);
  const empty=node('p',root,'По заданным фильтрам машин нет.','fleet-empty');
  const pager=node('div',root,undefined,'fleet-pager');
  const previous=button(pager,'Назад',()=>{page--;render();});
  const range=node('span',pager);range.setAttribute('aria-live','polite');
  const next=button(pager,'Далее',()=>{page++;render();});
  const modal=node('dialog',document.body,undefined,'fleet-dialog');
  modal.setAttribute('aria-labelledby','fleet-dialog-title');
  const collator=new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
  function filtered(){
    const term=search.value.trim().toLocaleLowerCase('ru');
    const rows=[...model.entries.values()].filter(({vehicle:v})=>
      (!term || (v.name+' '+v.type).toLocaleLowerCase('ru').includes(term)) &&
      (!availability.value || availability.value===v.availability) &&
      (!operation.value || v.operations.includes(operation.value)));
    if(sort.value==='name')rows.sort((a,b)=>collator.compare(a.vehicle.name,b.vehicle.name));
    if(sort.value==='rate')rows.sort((a,b)=>a.vehicle.rate-b.vehicle.rate);
    return rows;
  }
  function updateCounter(){
    const selected=[...model.entries.values()].filter(row=>row.active).length;
    counter.textContent='В смене '+selected+' из '+model.entries.size;
  }
  function toggleFiltered(active){
    const rows=filtered();
    if(!rows.some(row=>row.active!==active))return;
    for(const row of rows)row.active=active;
    render();onChange();
    (active?bulk:clear).focus();
  }
  function availabilityText(v){
    if(v.availability!=='reported')return availabilityNames[v.availability];
    const shift=getShift();
    const start=Date.parse(shift.date+'T'+shift.start+':00+12:00');
    const from=Date.parse(v.availableFrom+':00+12:00'), until=Date.parse(v.availableUntil+':00+12:00');
    if(!Number.isFinite(start))return availabilityNames.reported;
    return start>=from && start+shift.shiftMin*60000<=until?'Период покрывает смену':'Период не покрывает смену';
  }
  function render(){
    const rows=filtered();
    page=Math.min(Math.max(0,page),Math.max(0,Math.ceil(rows.length/pageSize)-1));
    updateCounter();empty.hidden=Boolean(rows.length);viewport.hidden=!rows.length;
    bulk.disabled=clear.disabled=!rows.length;
    const frag=document.createDocumentFragment();
    for(const entry of rows.slice(page*pageSize,(page+1)*pageSize)){
      const v=entry.vehicle,row=node('tr',frag);row.dataset.id=v.id;
      const selection=node('input',node('td',row));selection.type='checkbox';
      selection.checked=entry.active;selection.value=v.id;selection.setAttribute('aria-label','В смене: '+v.name);
      selection.onchange=()=>{entry.active=selection.checked;updateCounter();onChange();};
      const machine=node('td',row);node('strong',machine,v.name);node('small',machine,v.type);
      const capabilities=v.operations.map(key=>workTypes[key]??key);
      const ops=node('td',row,capabilities[0]??'Работы не выбраны');
      if(capabilities.length>1)node('small',ops,'Ещё '+(capabilities.length-1));
      ops.title=capabilities.join(', ');
      const status=node('td',row,availabilityText(v));
      if(v.availability==='reported' && v.availabilitySource)node('small',status,v.availabilitySource);
      const chars=node('td',row,new Intl.NumberFormat('ru').format(v.rate)+' ₽/ч');
      const dimensions=[v.widthM,v.massT,v.maxGradePct].every(x=>x!=null);
      node('small',chars,dimensions?v.widthM+' м · '+v.massT+' т · '+v.maxGradePct+'%':'Габариты или ограничения не заполнены');
      const edit=button(node('td',row),'Изменить',()=>editVehicle(v,edit));
      edit.setAttribute('aria-label','Изменить: '+v.name);
    }
    body.replaceChildren(frag);
    pager.hidden=rows.length<=pageSize;
    range.textContent='Строки '+(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,rows.length)+' из '+rows.length;
    previous.disabled=page===0;next.disabled=(page+1)*pageSize>=rows.length;
  }
  for(const control of [search,availability,operation,sort])control.addEventListener('input',()=>{page=0;render();});

  function editVehicle(current,opener){
    if(modal.open)return;
    const creating=!current;
    const vehicle=current??{id:'v-'+crypto.randomUUID(),name:'Машина '+(model.entries.size+1),type:'Снегоуборочная машина',
      rate:4000,workKmh:8,driveKmh:20,availability:'demo',operations:['patrol_plow']};
    let dirty=false;
    modal.replaceChildren();
    const form=node('form',modal);form.className='fleet-editor-form';
    const head=node('header',form,undefined,'fleet-editor-head');
    node('h2',head,creating?'Добавить машину':'Карточка машины').id='fleet-dialog-title';
    const fields=node('div',form,undefined,'fleet-editor-body');
    const inputs={};
    function group(title){
      const block=node('fieldset',fields);node('legend',block,title);
      return node('div',block,undefined,'fleet-editor-grid');
    }
    function field(parent,key,title,type,attrs={}){
      const el=labeled(parent,title,type==='select'?'select':'input');
      if(type!=='select')el.type=type;
      if(type==='select')options(el,availabilityNames);
      Object.assign(el,attrs);
      el.dataset.field=key;el.value=vehicle[key]??'';
      inputs[key]=el;return el;
    }
    const main=group('Основное');
    const name=field(main,'name','Название','text',{required:true,maxLength:120});
    field(main,'type','Тип машины','text',{required:true,maxLength:120});
    const work=group('Рабочие параметры');
    field(work,'rate','Тариф, ₽/ч','number',{min:'0.01',max:'1000000',step:'any',required:true});
    for(const [key,title] of [['workKmh','Расчистка, км/ч'],['driveKmh','Переезд, км/ч']])
      field(work,key,title,'number',{min:'0',max:'200',step:'any',required:true});
    const ops=group('Виды работ');
    for(const [key,title] of Object.entries(workTypes)){
      const label=node('label',ops,undefined,'fleet-check');
      const box=node('input',label);box.type='checkbox';box.dataset.operation=key;
      box.checked=vehicle.operations.includes(key);label.append(document.createTextNode(title));
    }
    const size=group('Габариты и масса');
    for(const [key,label,min,step] of [
      ['widthM','Ширина с оборудованием, м','0','any'],['massT','Рабочая масса, т','0','any'],
      ['maxGradePct','Допустимый уклон, %','0','any'],['tareKg','Масса без груза, кг','1','1'],
      ['payloadKg','Грузоподъёмность, кг','1','1'],['bodyM3','Объём кузова, м³','1','1']
    ])field(size,key,label,'number',{min,step,...(key==='bodyM3'?{max:'1000'}:{})});
    const period=group('Доступность в смене');
    const avail=field(period,'availability','Статус','select');
    const from=field(period,'availableFrom','Период с · Камчатка','datetime-local');
    const until=field(period,'availableUntil','Период до · Камчатка','datetime-local');
    const basis=field(period,'availabilitySource','Основание доступности','text',{maxLength:240});
    const note=node('small',period,'Параметры учебного парка задаёт диспетчер.','fleet-editor-note');
    function refreshPeriod(){
      const verified=avail.value==='reported';
      for(const el of [from,until,basis]){
        el.parentElement.hidden=!verified;el.required=verified;el.disabled=!verified;
      }
      note.hidden=avail.value!=='demo';
    }
    avail.onchange=refreshPeriod;refreshPeriod();
    const foot=node('footer',form,undefined,'fleet-editor-actions');
    const close=(focusId=vehicle.id)=>{
      modal.close();
      const edit=[...body.rows].find(row=>row.dataset.id===focusId)?.querySelector('button');
      (edit??(opener.isConnected?opener:addButton)).focus();
    };
    const cancel=()=>{if(!dirty||window.confirm('Отменить несохранённые изменения карточки?'))close();};
    modal.oncancel=e=>{e.preventDefault();cancel();};
    if(!creating)button(foot,'Удалить машину',()=>{
      if(!window.confirm('Удалить из парка машину «'+vehicle.name+'»?'))return;
      model.entries.delete(vehicle.id);render();onChange();close();
    },'row-button fleet-remove');
    button(foot,'Отмена',cancel);
    const save=node('button',foot,creating?'Добавить':'Сохранить','primary');save.type='submit';
    form.oninput=()=>{dirty=true;for(const el of Object.values(inputs))el.setCustomValidity('');};
    form.onsubmit=e=>{
      e.preventDefault();
      for(const el of [name,inputs.type,...(avail.value==='reported'?[basis]:[])]){
        if(!el.value.trim())el.setCustomValidity('Заполните поле текстом.');
      }
      for(const key of ['workKmh','driveKmh','widthM','massT']){
        const el=inputs[key];
        if(el.value!=='' && el.valueAsNumber<=0)el.setCustomValidity('Введите положительное значение.');
      }
      if(avail.value==='reported' && until.value<=from.value)until.setCustomValidity('Конец периода должен быть позже начала.');
      if(!form.reportValidity())return;
      const value={...vehicle,operations:[...ops.querySelectorAll(':checked')].map(el=>el.dataset.operation)};
      for(const [key,el] of Object.entries(inputs)){
        value[key]=el.type==='number'?(el.value===''?null:el.valueAsNumber):el.value.trim();
      }
      model.entries.set(value.id,{vehicle:value,active:model.entries.get(value.id)?.active??true});
      render();onChange();close();
    };
    modal.showModal();name.focus();name.select();
  }
  addButton.onclick=()=>editVehicle(null,addButton);
  return {
    reset(vehicles,selectedIds,rates){model=createFleetModel(vehicles,selectedIds,rates);page=0;render();},
    serialize:()=>model.serialize(),
    refresh:render,
    setBusy(busy){tools.inert=actions.inert=root.inert=busy;addButton.disabled=busy;}
  };
}
