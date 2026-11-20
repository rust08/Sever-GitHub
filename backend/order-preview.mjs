import {resourceReason,checkWorksite} from './equipment.mjs';
import {assessMandate,trainingClock,workTypes,recordStep,workflow} from './governance.mjs';
import {passesForEdge} from './policy.mjs';
import {plan} from './planner.mjs';

function matchAttachment(file,network,edgeId,operation,date){
  if(file?.mode!=='simulation' || file.networkVersion!==network.version || !Array.isArray(file.rows) || !file.rows.length || file.rows.length>100)
    throw Error('Нужен учебный файл для текущей версии сети, от 1 до 100 строк');
  const edgeIds=new Set(network.edges.map(e=>e.id));
  const dateOk=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  const matches=[],unmatched=[];
  for(const [index,row] of file.rows.entries()){
    const fields=['edgeId','customer','executor','officer','contractId','source','clause','reviewer'];
    if(!row || fields.some(k=>typeof row[k]!=='string' || !row[k].trim() || row[k].length>240) ||
        !Object.hasOwn(workTypes,row.operation) || !dateOk(row.from) || !dateOk(row.until) || row.from>=row.until)
      throw Error('Проверьте поля, операцию и период строки '+(index+1));
    if(!edgeIds.has(row.edgeId))unmatched.push(index+1);
    if(row.edgeId===edgeId && row.operation===operation && row.from<=date && date<row.until)matches.push(row);
  }
  return {matches,unmatched};
}

// All order scenarios are simulations.
export function previewOrder(data,input,request) {
  const edge=data.network.edges.find(e=>e.id===request.edgeId);
  if(!edge || !Object.hasOwn(workTypes,request.operation) || !['unknown','example','outside','expired','attachment'].includes(request.scenario))
    throw Error('Проверьте участок, операцию и учебный сценарий');
  const {operation,scenario}=request;
  const vehicles=(input.fleet??data.fleet).filter(v=>input.vehicleIds.includes(v.id));
  const machine=request.vehicleId===undefined ? vehicles[0] : vehicles.find(v=>v.id===request.vehicleId);
  if(!machine)throw Error('Выберите машину из сохранённой смены');
  const offset=request.withEvent===true ? (request.eventOffsetMin??0) : 0;
  if(!Number.isInteger(offset) || offset<0 || offset>input.shiftMin)
    throw Error('Время события должно попадать в смену');
  const at=input.date+'T'+input.start+':00+12:00';
  const doc={status:'checked',document:'Учебный образец',start:at,end:new Date(Date.parse(at)+86400000).toISOString()};
  const known=scenario!=='unknown';
  const asset={id:edge.id,...(known?{...doc,owner:'Учебный владелец',balanceHolder:'Учебная служба',territory:'demo',legalClass:'учебная группа'}:{})};
  const operations=['patrol_plow'];
  const responsibility=known?{...doc,authority:'Учебный заказчик',executor:'Учебный подрядчик',officer:'Дежурный А',assetId:edge.id,operations}:null;
  const contract=known?{...doc,customer:responsibility.authority,executor:responsibility.executor,assets:scenario==='outside'?[]:[edge.id],operations}:null;
  if(scenario==='expired'){
    contract.start=new Date(Date.parse(at)-86400000).toISOString();
    contract.end=at;
  }
  const resource=known&&machine?{...doc,id:machine.id,permitted:true,executor:responsibility.executor,operations}:null;
  let attachment=null;
  if(scenario==='attachment'){
    const {matches,unmatched}=matchAttachment(request.attachment,data.network,edge.id,operation,input.date);
    attachment={unmatched,matchCount:matches.length};
    if(matches.length===1){
      const row=matches[0];
      Object.assign(contract,{document:row.source,clause:row.clause,id:row.contractId,reviewer:row.reviewer,customer:row.customer,executor:row.executor,
        start:row.from+'T00:00:00+12:00',end:row.until+'T00:00:00+12:00',operations:[operation]});
      Object.assign(responsibility,{authority:row.customer,executor:row.executor,officer:row.officer,operations:[operation]});
      resource.executor=row.executor;
    }
  }
  if(resource)resource.operations=machine.operations??operations;
  const mandate=assessMandate({asset,resource,contract,responsibility,operation,at});
  const worksite=request.worksite??{};
  const limits=checkWorksite(machine,worksite);
  const reason=resourceReason(machine,input,operation);
  if(reason)mandate.conflicts.push(reason);
  mandate.missing.push(...limits.missing);mandate.conflicts.push(...limits.conflicts);
  if(mandate.conflicts.length)mandate.status='blocked';
  else if(mandate.missing.length)mandate.status='manual_review';
  if(attachment && attachment.matchCount!==1){
    mandate.status=attachment.matchCount || mandate.conflicts.length?'blocked':'manual_review';
    (attachment.matchCount?mandate.conflicts:mandate.missing).push(attachment.matchCount?'Несколько действующих строк на один участок и операцию':'Нет строки на выбранный участок, операцию и дату');
  }
  const {objectType='roadway',queue=1,eventKind='snowfall_end',repeatOffsetMin}=request;
  if(!['roadway','sidewalk'].includes(objectType) || ![1,2].includes(queue) || !['snowfall_end','ice_detected'].includes(eventKind))
    throw Error('Проверьте учебный паспорт и тип события');
  if(repeatOffsetMin!=null && (request.withEvent!==true || !Number.isInteger(repeatOffsetMin) || repeatOffsetMin<=offset || repeatOffsetMin>input.shiftMin))
    throw Error('Повторное событие должно быть позже первого и попадать в смену');
  if(known)Object.assign(asset,{objectType,queue});
  const stamps=repeatOffsetMin==null?[offset]:[offset,repeatOffsetMin];
  const episodes=stamps.map(minutes=>{
    const timestamp=new Date(Date.parse(at)+minutes*60000).toISOString();
    const event=known && request.withEvent===true?{...doc,id:JSON.stringify([edge.id,eventKind,timestamp]),assetId:edge.id,kind:eventKind,at:timestamp}:null;
    return trainingClock(asset,operation,event,at);
  });
  const {rule,event,clock}=episodes[0];
  let routing=null;
  if(mandate.status==='eligible'){
    const pass=passesForEdge(edge,true).find(p=>p.reverse===Boolean(request.reverse));
    if(pass){
      const vehicle={...machine,rate:input.rates?.[machine.id]??machine.rate};
      const result=plan(data.network,[{...pass,priority:4,targetMin:input.shiftMin}],[vehicle],{...input,vehicleIds:[machine.id]});
      routing={assigned:result.summary.assigned===1,cost:result.summary.cost,vehicle:vehicle.name,
        minutes:result.routes[0].minutes,reason:result.unassigned[0]?.reason};
    }else routing={assigned:false,reason:'Направление недоступно для техники'};
  }
  const identity=[data.network.version,request.shiftId,edge.id,Boolean(request.reverse),operation,scenario];
  // Preserve saved journals for the original first-machine, zero-offset scenario.
  if(machine.id!==vehicles[0].id || offset)identity.push(machine.id,offset);
  if(attachment?.matchCount===1)identity.push(contract,responsibility.officer);
  if(objectType!=='roadway' || queue!==1 || eventKind!=='snowfall_end' || repeatOffsetMin!=null)identity.push(objectType,queue,eventKind,repeatOffsetMin??null);
  if(Object.keys(worksite).length)identity.push(worksite);
  const id=JSON.stringify(identity);
  const order={id,dispatchable:routing?.assigned===true};
  let history=[];
  if(!Array.isArray(request.history) || request.history.length>8)throw Error('Проверьте журнал');
  for(const entry of request.history)history=recordStep(order,history,entry);
  const state=history.at(-1)?.state??'planned';
  const actions=order.dispatchable?Object.entries(workflow[state]).map(([state,role])=>({state,role})):[];
  return {mode:'simulation',id,state,history,actions,mandate,clock,routing,asset,responsibility:attachment && attachment.matchCount!==1?null:responsibility,
    contract:attachment && attachment.matchCount!==1?null:contract,operation,resource:attachment && attachment.matchCount!==1?null:resource,rule,event,episodes,attachment,worksite};
}

