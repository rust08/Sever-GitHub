import {territoryPilot} from './territory-pilot.js';
import {cityContext} from './city-context.js';
// Leaflet owns the projection, panning, zoom, clipping and canvas hit testing.
const L = window.L;
const COLORS = {none:'#99a6a8', p1:'#bd2650', p2:'#a55108', p3:'#2a668e', p4:'#657e80',
  pending:'#547394', active:'#005faa', partial:'#896422', done:'#22784a', missed:'#ab4455'};
const swatch = (color, weight, dashArray = null) => ({color, weight, dashArray, opacity:1});
const STYLES = {
  single:swatch('#286faf',5),overlap:swatch('#ae3062',6),
  none:swatch(COLORS.none,1), p1:swatch(COLORS.p1,5), p2:swatch(COLORS.p2,3.8),
  p3:swatch(COLORS.p3,2.5), p4:swatch(COLORS.p4,1.4), pending:swatch(COLORS.pending,2.5),
  active:swatch(COLORS.active,6), partial:swatch(COLORS.partial,3.5), done:swatch(COLORS.done,3.5),
  missed:swatch(COLORS.missed,2.8,'4 3'), closed:swatch('#ad223e',5,'6 3'), draft:swatch('#da680d',5,'6 3')
};
const labels = {
  priority:[['p1','P1 · срочный вызов'],['p2','P2 · основные дороги'],['p3','P3 · районные'],['p4','P4 · местные'],['none','Без задания']],
  state:[['pending','Запланировано'],['active','В работе'],['partial','Часть проходов завершена'],['done','Все проходы завершены'],['missed','Без назначения']],
  routes:[['active','Расчистка'],['drive','Переезд']]
};
const reliefBounds = [[663,1924],[671,1931]].map(([y,x]) => [
  Math.atan(Math.sinh(Math.PI * (1 - 2*y/2048))) * 180/Math.PI, x/2048*360-180
]);
function append(map, id, value) {
  const list=map.get(id);
  if(list) list.push(value);
  else map.set(id,[value]);
}
function interpolate(path, fraction) {
  let remaining = path.length * Math.max(0,Math.min(1,fraction));
  for (let i=1;i<path.points.length;i++) {
    const span=path.segments[i-1];
    if(remaining<=span && span>0) {
      const a=path.points[i-1], b=path.points[i], f=remaining/span;
      return L.latLng(a.lat+(b.lat-a.lat)*f,a.lng+(b.lng-a.lng)*f);
    }
    remaining -= span;
  }
  return path.points.at(-1);
}
// Detail is indexed by hundredths of a degree so street zoom loads only the viewport.
function addStreetDetail(map) {
  map.createPane('geography').style.zIndex='320';
  map.getPane('geography').style.pointerEvents='none';
  const renderer=L.canvas({pane:'geography',padding:.2});
  const group=L.layerGroup().addTo(map);
  const colors={building:'#a9a99f',forest:'#bbceb6',park:'#c6d9bb',brush:'#d0d9c1',urban:'#e8e6dd',
    industrial:'#dad7ce',water:'#aacacd',river:'#81afb4',coast:'#73a7ac'};
  function refresh() {
    group.clearLayers();
    if(map.getZoom()<11.5)return;
    const rect=map.getBounds().pad(.1), ids=new Set();
    for(let x=Math.floor(rect.getWest()*100);x<=Math.floor(rect.getEast()*100);x++){
      for(let y=Math.floor(rect.getSouth()*100);y<=Math.floor(rect.getNorth()*100);y++){
        for(const id of cityContext.cells[x+'/'+y]||[])ids.add(id);
      }
    }
    for(const id of [...ids].sort((a,b)=>a-b)){
      const [kind,rings]=cityContext.records[id];
      if(kind==='building' && map.getZoom()<14.5)continue;
      const lines=rings.map(ring=>{
        const line=[];let x=0,y=0;
        for(let i=0;i<ring.length;i+=2){x+=ring[i];y+=ring[i+1];line.push([y/100000,x/100000]);}
        return line;
      });
      const style={pane:'geography',renderer,interactive:false,color:colors[kind],weight:1,fillOpacity:kind==='building'?.76:kind==='water'?1:.40,opacity:kind==='coast'?.75:.45};
      if(kind==='coast'||kind==='river')L.polyline(lines,style).addTo(group);
      else L.polygon(lines,style).addTo(group);
    }
  }
  map.on('moveend',refresh);
}
export class RoadMap {
  constructor(container,network,color,onSelect,tasks=[]) {
    this.network=network;
    this.color=color;
    this.onSelect=onSelect;
    this.mode='priority';
    this.tasks=new Map(tasks.map(t=>[String(t.id),t]));
    this.edgeTasks=new Map();
    for (const task of tasks) append(this.edgeTasks,String(task.edgeId),task);
    this.paths=new Map();
    this.closed=new Set();
    this.urgent=new Set();
    this.legs=new Map();
    this.missed=new Set();
    this.overrides=new Map();
    this.extraByEdge=new Map();
    this.map=L.map(container,{preferCanvas:true,zoomControl:false,minZoom:9,maxZoom:19,
      attributionControl:false,zoomSnap:0.25,zoomDelta:1,renderer:L.canvas({tolerance:3,padding:.15})});
    this.map.setMaxBounds(L.latLngBounds(reliefBounds));
    L.imageOverlay('/terrain-map.webp',reliefBounds,{pane:'tilePane',interactive:false,alt:'Рельеф Авачинской губы'}).addTo(this.map);
    addStreetDetail(this.map);
    this.cityRoads=L.layerGroup().addTo(this.map);
    this.bounds=L.latLngBounds();
    for(const edge of network.edges) {
      const geometry=edge.geometry?.coordinates || edge.geometry;
      const coords=geometry?.length>1?geometry:[network.nodes[edge.from],network.nodes[edge.to]];
      const points=coords.map(([lon,lat])=>L.latLng(lat,lon));
      const id=String(edge.id);
      const line=L.polyline(points,{...STYLES.none,bubblingMouseEvents:false}).addTo(this.cityRoads);
      line.on('click',()=>this.highlight(id));
      this.bounds.extend(line.getBounds());
      const taskList=this.edgeTasks.get(id) || [];
      const priority=taskList.reduce((p,t)=>Math.min(t.priority,p),5);
      this.paths.set(id,{edge,line,points,taskList,priority,style:null});
    }
    this.map.createPane('routeLayer').style.zIndex='420';
    this.map.getPane('routeLayer').style.pointerEvents='none';
    this.routeRenderer=L.canvas({pane:'routeLayer'});
    this.routeLayers=L.layerGroup().addTo(this.map);
    this.markers=L.layerGroup().addTo(this.map);
    this.depot=L.latLng([...network.nodes[network.depot]].reverse());
    L.marker(this.depot,{icon:L.divIcon({className:'snow-depot',html:'◆',iconSize:[16,16],iconAnchor:[8,8]}),
      interactive:false,keyboard:false,title:'База'}).addTo(this.map);
    this.map.on('click',()=>this.highlight(null));
    document.querySelector('#map-mode').addEventListener('change',e=>{
      this.setMode(e.target.value);
    });
    this.observer=new ResizeObserver(()=>this.map.invalidateSize({pan:false}));
    this.observer.observe(container);
    this.map.setView([53.035,158.654],12.75);this.legend();this.paint(true);
  }
  setMode(mode) {
    if(this.mode===mode)return;
    this.highlight(null);
    this.mode=mode;
    if(mode==='territory'){
      this.previousView={center:this.map.getCenter(),zoom:this.map.getZoom()};
      this.cityRoads.remove();
      this.markers.remove();
      if(!this.pilot){
        this.pilot=L.featureGroup();
        for(const [id,name,way,coordinates] of territoryPilot.roads){
          const points=coordinates.map(([longitude,latitude])=>[latitude,longitude]);
          const line=L.polyline(points,{color:'#59646c',weight:5,bubblingMouseEvents:false}).addTo(this.pilot);
          line.pilotId=id;
          line.bindPopup(()=>{
            const card=document.createElement('div');
            const title=document.createElement('strong');
            title.textContent=name || 'Участок без названия';
            const details=document.createElement('p');
            details.textContent='Расчистка · '+territoryPilot.date+' · исполнитель не подтверждён. Участок '+id+' · OSM way '+way;
            card.append(title,details);
            if(this.showPilotHints)for(const [date,operation,operator,url] of territoryPilot.hints[id]??[]){
              const hint=document.createElement('p');
              hint.textContent=date+' · '+operator+' · '+operation+' · совпало название улицы. Граница работ не подтверждена. ';
              const source=document.createElement('a');source.href=url;source.target='_blank';source.rel='noreferrer';source.textContent='Историческое сообщение';
              hint.append(source);card.append(hint);
            }
            return card;
          });
        }
      }
      this.pilot.addTo(this.map);
      this.map.fitBounds(this.pilot.getBounds(),{padding:[16,16],animate:false});
    }else if(this.previousView){
      this.map.closePopup();
      this.pilot.remove();
      this.cityRoads.addTo(this.map);
      this.markers.addTo(this.map);
      this.map.setView(this.previousView.center,this.previousView.zoom,{animate:false});
      this.previousView=null;
    }
    document.getElementById('map-mode').value=mode;
    this.legend();this.paint(true);
    this.onModeChange?.(mode);
  }
  legend() {
    const root=document.getElementById('map-legend');
    root.replaceChildren();
    if(this.mode==='territory'){
      root.textContent='Пилот · '+territoryPilot.date+' · расчистка. Для всех '+territoryPilot.roads.length+' участков исполнитель не подтверждён. Нажмите на дорогу для просмотра.';
      const label=document.createElement('label'),toggle=document.createElement('input');
      toggle.type='checkbox';toggle.checked=Boolean(this.showPilotHints);
      toggle.onchange=()=>{
        this.showPilotHints=toggle.checked;this.map.closePopup();
        this.pilot.eachLayer(line=>line.setStyle({color:toggle.checked && territoryPilot.hints[line.pilotId]?'#7840a0':'#59646c'}));
      };
      label.append(toggle,document.createTextNode('Фиолетовый — историческое упоминание улицы'));root.append(label);
      return;
    }
    if(this.mode==='coverage'){root.textContent='Серый — без строки · синий — одна строка · малиновый — пересечение строк';return;}
    for(const [key,label] of [...labels[this.mode],['closed','Перекрыто'],['draft','Изменение перекрытия'],['base','База']]) {
      const row=document.createElement('span'), mark=document.createElement('i');
      if(key==='base') mark.textContent='◆';
      else {
        mark.style.borderColor=STYLES[key]?.color || COLORS.active;
        if(STYLES[key]?.dashArray || key==='drive') mark.style.borderTopStyle='dashed';
      }
      row.append(mark,document.createTextNode(label));root.append(row);
    }
  }
  focus(id) {
    if(this.mode==='territory')this.setMode('priority');
    const path=this.paths.get(String(id));if(!path)return;
    this.map.fitBounds(path.line.getBounds(),{maxZoom:17,padding:[48,48],animate:false});
    this.highlight(String(id));
  }
  fit(){this.map.fitBounds(this.bounds,{padding:[16,16],animate:false});this.highlight(null);}
  zoom(factor){this.map.setZoom(this.map.getZoom()+(factor>1?1:-1));}
  highlight(id) {
    this.selected=id;
    this.selection?.remove();this.selection=null;
    const path=this.paths.get(id);
    if(path) this.selection=L.polyline(path.points,{pane:'routeLayer',renderer:this.routeRenderer,
      weight:8,color:'#fbc336',opacity:.83,interactive:false}).addTo(this.map);
    this.onSelect(id);
  }
  show(plan,vehicle,minute) {
    const changed=this.plan!==plan || this.vehicle!==vehicle;
    if(changed) {
      this.plan=plan;this.vehicle=vehicle;
      this.routes=(plan?.result.routes || []).filter(r=>!vehicle || String(r.vehicleId)===String(vehicle));
      this.closed=new Set((plan?.input.closed || []).map(String));
      this.legs=new Map();this.missed=new Set();this.overrides=new Map();
      for(const route of plan?.result.routes || []) {
        for(const leg of route.legs) if(leg.type==='work') append(this.legs,String(leg.edgeId),leg);
      }
      this.extraByEdge=new Map();
      const optionalTasks=new Map();
      for(const item of plan?.result.priorities || []) {
        if(this.tasks.has(String(item.id)) || item.edgeId==null)continue;
        const id=String(item.id), edgeId=String(item.edgeId);
        if(!this.paths.has(edgeId) || optionalTasks.has(id))continue;
        optionalTasks.set(id,item);
        this.extraByEdge.set(edgeId,(this.extraByEdge.get(edgeId) || 0)+1);
      }
      for(const entry of plan?.result.unassigned || []) {
        const task=this.tasks.get(String(entry.taskId)) || optionalTasks.get(String(entry.taskId));
        if(task)this.missed.add(String(task.edgeId));
      }
      for(const item of plan?.result.priorities || []) {
        const task=this.tasks.get(String(item.id)) || optionalTasks.get(String(item.id));if(!task)continue;
        const id=String(task.edgeId);this.overrides.set(id,Math.min(this.overrides.get(id) || 5,item.priority));
      }
    }
    this.minute=Number(minute) || 0;
    this.paint(changed);
  }
  updateDraft(ids) {this.draft=new Set(ids.map(String));this.paint(true);}
  updateIncidents(ids) {
    this.urgent=new Set();
    for(const value of ids){
      const id=String(value), task=this.tasks.get(id);
      const extra=task ? null : /^pass:(.+):[fr]$/.exec(id);
      const edgeId=task ? String(task.edgeId) : extra?.[1];
      if(this.paths.has(edgeId))this.urgent.add(edgeId);
    }
    this.hasDraftIncidents=true;
    this.paint(true);
  }
  styleFor(id,path) {
    if(this.mode==='coverage'){const n=this.coverage?.get(id)?.length??0;return n>1?'overlap':n?'single':'none';}
    const closed=this.closed.has(id), proposed=this.draft?.has(id) ?? closed;
    if(closed!==proposed)return 'draft';
    if(closed)return 'closed';
    if(this.mode==='priority') {
      const saved=this.hasDraftIncidents?5:(this.overrides.get(id) ?? 5);
      const level=this.urgent.has(id)?1:Math.min(path.priority,saved);
      return level<5?'p'+level:'none';
    }
    const required=path.taskList.length + (this.extraByEdge.get(id) || 0);
    if(this.mode==='routes' || !required)return 'none';
    const work=this.legs.get(id) || [];
    let done=0;
    for(const leg of work) {
      if(leg.startMin<=this.minute && this.minute<leg.endMin)return 'active';
      if(leg.endMin<=this.minute)done++;
    }
    if(done===required)return 'done';
    if(done)return 'partial';
    if(this.missed.has(id))return 'missed';
    return work.length?'pending':'none';
  }
  paint(changed) {
    if(changed || this.mode==='state') {
      for(const [id,path] of this.paths) {
        const key=this.styleFor(id,path);
        if(path.style!==key){path.line.setStyle(STYLES[key]);path.style=key;}
      }
    }
    if(changed) {
      this.routeLayers.clearLayers();
      if(this.mode==='routes') {
        for(const type of ['drive','work']) for(const route of this.routes || []) {
          const lines=[];
          for(const leg of route.legs){
            const id=String(leg.edgeId), path=this.paths.get(id);
            if(leg.type===type && path && !this.closed.has(id) && !this.draft?.has(id))lines.push(path.points);
          }
          if(lines.length)L.polyline(lines,{renderer:this.routeRenderer,interactive:false,color:this.color(route.vehicleId),
            weight:type==='work'?4:2,opacity:type==='work'?0.93:0.72,dashArray:type==='work'?null:'4 4'}).addTo(this.routeLayers);
        }
      }
    }
    this.markers.clearLayers();
    if(this.mode==='coverage')return;
    const positions=new Map();
    for(const route of this.routes || []) {
      if(!route.legs.length)continue;
      const leg=route.legs.find(l=>l.startMin<=this.minute && this.minute<l.endMin);
      let location=this.depot;
      if(leg) {
        const path=this.paths.get(String(leg.edgeId));if(!path)continue;
        if(!path.segments) {
          path.segments=path.points.slice(1).map((p,j)=>path.points[j].distanceTo(p));
          path.length=path.segments.reduce((sum,v)=>sum+v,0);
        }
        let f=(this.minute-leg.startMin)/(leg.endMin-leg.startMin);
        if(String(path.edge.from)!==String(leg.from))f=1-f;
        location=interpolate(path,f);
      }
      const positionKey=location.lat+','+location.lng;
      if(!positions.has(positionKey))positions.set(positionKey,{location,routes:[]});
      positions.get(positionKey).routes.push(route);
    }
    for(const {location,routes} of positions.values()) {
      const grouped=routes.length>1;
      const pin=document.createElement('span');
      pin.style.background=grouped?'#294958':this.color(routes[0].vehicleId);
      pin.textContent=grouped?routes.length+' маш.':this.plan.result.routes.indexOf(routes[0])+1;
      const size=grouped?[18+pin.textContent.length*6,21]:[21,21];
      L.marker(location,{interactive:false,keyboard:false,
        icon:L.divIcon({className:'snow-truck'+(grouped?' grouped':''),html:pin,iconSize:size,iconAnchor:[size[0]/2,10]}),
        title:routes.map(r=>r.name).join(', '),zIndexOffset:25}).addTo(this.markers);
    }
  }
}

