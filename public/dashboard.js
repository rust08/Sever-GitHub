const screenCopy={
  overview:['Обзор смены','План расчистки и положение машин на карте города.'],
  plan:['План смены','Настройте время, бюджет и приоритеты, затем рассчитайте маршруты.'],
  fleet:['Техника','Выберите машины для смены и проверьте их возможности.'],
  haul:['Снеговывоз','Погрузка, путь до площадки и возврат самосвалов.'],
  orders:['Наряды','Выдача задания, отчёт исполнителя, проверка и решение заказчика.'],
  registries:['Реестры','Территории, редакции документов и источники сведений о технике.']
};
const oldLinks={'shift-map':'overview','shift-settings':'plan','shift-details':'plan',registry:'registries',main:'overview'};
export function dashboardView(hash){
  if(Object.hasOwn(screenCopy,hash))return hash;
  return Object.hasOwn(oldLinks,hash)?oldLinks[hash]:'overview';
}
export function initDashboard(){
  const el=id=>document.getElementById(id);
  let tab='scope';
  const theme=matchMedia('(prefers-color-scheme: dark)');
  let manualTheme;
  function applyTheme(){
    let choice;
    try{choice=localStorage.getItem('sever-dashboard-theme');}catch{}
    const dark=manualTheme==='dark'||(manualTheme!=='light' && (choice==='dark'||(choice!=='light'&&theme.matches)));
    document.documentElement.dataset.theme=dark?'dark':'light';
    el('theme-toggle').textContent=dark?'☀  Светлая тема':'☾  Тёмная тема';
    el('theme-toggle').setAttribute('aria-label',dark?'Включить светлую тему':'Включить тёмную тему');
  }
  applyTheme();theme.addEventListener('change',applyTheme);
  el('theme-toggle').onclick=()=>{
    const next=document.documentElement.dataset.theme==='dark'?'light':'dark';
    manualTheme=next;
    try{localStorage.setItem('sever-dashboard-theme',next);}catch{}
    applyTheme();
  };
  function regTab(next){
    tab=next;
    document.querySelectorAll('[data-reg-pane]').forEach(p=>p.hidden=p.dataset.regPane!==next);
    document.querySelectorAll('[data-reg-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.regTab===next)));
    if(next==='documents'&&!el('registry-panel').hidden)el('registry-panel').open=true;
    el('registry-local-note').hidden=!el('registry-panel').hidden;
  }
  document.querySelectorAll('[data-reg-tab]').forEach(b=>b.onclick=()=>regTab(b.dataset.regTab));
  function render(){
    const hash=location.hash.slice(1);
    const view=dashboardView(hash);
    document.querySelectorAll('[data-screen]').forEach(p=>p.hidden=p.dataset.screen!==view);
    document.querySelectorAll('[data-view]').forEach(a=>{
      if(a.dataset.view===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    });
    const host=document.querySelector('[data-map-host="'+view+'"]');
    if(host && el('shift-map').parentElement!==host)host.append(el('shift-map'));
    [el('screen-title').textContent,el('screen-description').textContent]=screenCopy[view];
    el('overview-action').hidden=view!=='overview';
    if(document.body.dataset.view==='haul' && view!=='haul')document.dispatchEvent(new Event('sever:leave-haul'));
    document.body.dataset.view=view;
    if(view==='registries')regTab(tab);
    if(hash==='shift-details')requestAnimationFrame(()=>el('shift-details').scrollIntoView({block:'start'}));
  }
  function navigate(view){
    if(location.hash!=='#'+view)history.pushState(null,'','#'+view);
    render();
    window.scrollTo(0,0);
  }
  window.addEventListener('hashchange',()=>{render();if(location.hash!=='#shift-details')window.scrollTo(0,0);});
  el('show-skipped').onclick=()=>document.querySelector('[data-page="unassigned"]').click();
  el('coverage-open').onclick=()=>{
    const mode=el('map-mode');mode.value=[...mode.options].some(o=>o.value==='coverage')?'coverage':'territory';
    mode.dispatchEvent(new Event('change'));el('shift-map').scrollIntoView({block:'start'});
  };
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!el('pick-banner').hidden)el('cancel-map-pick').click();
    else if(e.key==='Escape'&&!el('map-info').hidden){el('map-info').hidden=true;el('map').focus();}
  });
  render();
  return navigate;
}
