import {randomUUID} from 'node:crypto';
import {evaluateOrder, InputError} from './service.mjs';

// These four fixed identities exist only in the loopback simulator.
const actors = {dispatcher:'demo-dispatcher', executor:'demo-contractor', inspector:'demo-inspector', customer:'demo-customer'};
const transitions = {
  created:{issued:'dispatcher', cancelled:'dispatcher'},
  issued:{started:'executor', cancelled:'dispatcher'},
  started:{reported:'executor'},
  reported:{inspected:'inspector', needs_rework:'inspector'},
  inspected:{accepted:'customer', rejected:'customer', needs_rework:'customer'},
  needs_rework:{started:'executor'}, rejected:{disputed:'executor'}
};
class JournalError extends Error {
  constructor(status,message){super(message); this.status=status;}
}
function requireThat(condition,status,message){
  if(!condition) throw new JournalError(status,message);
}
function history(db,id){
  const order=db.prepare('SELECT shift_id,snapshot_json FROM work_orders WHERE id=?').get(id);
  requireThat(order,404,'Наряд не найден');
  const events=db.prepare('SELECT sequence,event_type,actor,role,occurred_at,recorded_at,comment FROM work_order_events WHERE order_id=? ORDER BY sequence').all(id);
  const last=events.at(-1);
  return {id,simulation:true,shiftId:order.shift_id,snapshot:JSON.parse(order.snapshot_json),events,status:last.event_type,version:last.sequence,next:transitions[last.event_type]??{}};
}
function record(db,id,seq,type,role,at,comment,key,signature){
  db.prepare('INSERT INTO work_order_events VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id,seq,type,actors[role],role,at,new Date().toISOString(),comment,key,signature);
  if(role==='inspector'||role==='customer') db.prepare('INSERT INTO work_order_reviews VALUES (?,?)').run(id,seq);
}
function create(db,data,body,key,role){
  requireThat(role==='dispatcher',403,'Создание доступно учебному диспетчеру');
  const {shiftId,edgeId,vehicleId,operation,reverse=false}=body;
  requireThat([shiftId,edgeId,vehicleId,operation].every(v=>typeof v==='string'&&v.length>0&&v.length<=240)&&typeof reverse==='boolean',400,'Проверьте смену, участок, направление, операцию и машину');
  const signature=JSON.stringify([shiftId,edgeId,reverse,vehicleId,operation]);
  const existing=db.prepare('SELECT id,creation_request FROM work_orders WHERE creation_key=?').get(key);
  if(existing){
    requireThat(existing.creation_request===signature,409,'Ключ создания уже использован');
    return existing.id;
  }
  const saved=db.prepare('SELECT input_json FROM city_plans WHERE id=? AND network_version=?').get(shiftId,data.network.version);
  requireThat(saved,404,'Сохранённая смена для текущей сети не найдена');
  const shift=JSON.parse(saved.input_json);
  const p=evaluateOrder(data,{shift,shiftId,edgeId,operation,vehicleId,reverse,scenario:'example',history:[],withEvent:true});
  requireThat(p.mandate.status==='eligible' && p.routing?.assigned && !shift.closed?.includes(edgeId),422,'Нет допуска или доступного маршрута');
  const task=JSON.stringify([shiftId,edgeId,reverse,operation]);
  requireThat(!db.prepare('SELECT id FROM work_orders WHERE task_key=?').get(task),409,'На это задание уже создан наряд');
  const snapshot={networkVersion:data.network.version,edgeId,reverse,vehicleId,operation,assignee:actors.executor,
    scenario:'example',basis:'Учебный образец v1',contract:p.contract,rule:p.rule,clock:p.clock,
    shiftStart:new Date(Date.parse(shift.date+'T'+shift.start+':00+12:00')).toISOString(),shiftMinutes:shift.shiftMin,routing:p.routing};
  const id=randomUUID();
  db.prepare('INSERT INTO work_orders VALUES (?,?,?,?,?,?)').run(id,shiftId,JSON.stringify(snapshot),key,signature,task);
  record(db,id,1,'created',role,snapshot.shiftStart,'Учебный наряд создан',key,signature);
  return id;
}
function advance(db,id,body,key,role){
  const {expected_version:version,event_type:type,comment,occurred_at:at}=body;
  requireThat(Number.isSafeInteger(version)&&version>=1&&typeof type==='string'&&typeof comment==='string'&&comment.trim()&&comment.length<=1000,400,'Нужны версия, действие и пояснение до 1000 знаков');
  requireThat(typeof at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(at)&&Number.isFinite(Date.parse(at)),400,'Укажите дату и время события с часовым поясом');
  const utc=new Date(at).toISOString();
  const signature=JSON.stringify([version,type,role,comment,utc]);
  const order=history(db,id);
  const repeat=db.prepare('SELECT request_json FROM work_order_events WHERE order_id=? AND request_key=?').get(id,key);
  if(repeat){
    requireThat(repeat.request_json===signature,409,'Ключ уже использован для другого события');
    return id;
  }
  requireThat(version===order.version,409,'Наряд уже изменён. Обновите журнал');
  requireThat(Object.hasOwn(order.next,type),409,'Недопустимый переход');
  requireThat(order.next[type]===role,403,'Действие недоступно этой учебной роли');
  requireThat(role!=='executor'||order.snapshot.assignee===actors[role],403,'Наряд назначен другому исполнителю');
  requireThat(utc>=order.events.at(-1).occurred_at,400,'Событие раньше предыдущего');
  record(db,id,version+1,type,role,utc,comment,key,signature);
  return id;
}
export async function journalResponse(request,db,data){
  const path=new URL(request.url).pathname;
  const match=/^\/api\/work-orders(?:\/([a-z0-9-]+)(\/events)?)?$/.exec(path);
  try{
    requireThat(match,404,'Ресурс не найден');
    if(request.method==='GET' && !match[1]){
      const shiftId=new URL(request.url).searchParams.get('shiftId');
      requireThat(shiftId && shiftId.length<=100,400,'Для списка требуется shiftId');
      const orders=db.prepare(`SELECT o.id,e.event_type AS status,e.sequence AS version
        FROM work_orders o JOIN work_order_events e ON e.order_id=o.id
        WHERE o.shift_id=? AND e.sequence=(SELECT MAX(sequence) FROM work_order_events WHERE order_id=o.id)
        ORDER BY o.rowid`).all(shiftId);
      return Response.json({simulation:true,orders},{headers:{'Cache-Control':'no-store'}});
    }
    if(request.method==='GET' && match[1] && !match[2]) return Response.json(history(db,match[1]),{headers:{'Cache-Control':'no-store'}});
    requireThat(request.method==='POST' && (!match[1]||match[2]),405,'Метод недоступен');
    requireThat(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'Требуется JSON');
    const role=request.headers.get('x-simulation-role');
    requireThat(Object.hasOwn(actors,role),403,'Требуется учебная роль локального стенда');
    const body=await request.json().catch(()=>null);
    requireThat(body && typeof body==='object' && !Array.isArray(body),400,'Требуется объект JSON');
    const allowed=match[1]?['expected_version','event_type','occurred_at','comment']:['shiftId','edgeId','vehicleId','operation','reverse'];
    requireThat(Object.keys(body).every(k=>allowed.includes(k)),400,'Неизвестное поле запроса');
    const key=request.headers.get('idempotency-key');
    requireThat(key && /^[A-Za-z0-9_-]{1,100}$/.test(key),400,'Требуется Idempotency-Key');
    db.exec('BEGIN IMMEDIATE');
    try{
      const id=match[1]?advance(db,match[1],body,key,role):create(db,data,body,key,role);
      const result=history(db,id);
      db.exec('COMMIT');
      return Response.json(result,{headers:{'Cache-Control':'no-store'}});
    }catch(error){db.exec('ROLLBACK'); throw error;}
  }catch(error){
    if(!(error instanceof JournalError || error instanceof InputError)) throw error;
    return Response.json({error:error.message},{status:error.status??400});
  }
}
