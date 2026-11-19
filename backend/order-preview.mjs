import {assessMandate,assessClock,workTypes,recordStep,workflow} from './governance.mjs';
import {passesForEdge} from './policy.mjs';
import {plan} from './planner.mjs';

// The only supplied dossier is fictional and covers one plowing operation on one asset.
export function previewOrder(data,input,request) {
  const edge=data.network.edges.find(e=>e.id===request.edgeId);
  if(!edge || !Object.hasOwn(workTypes,request.operation) || !['unknown','example','outside','expired'].includes(request.scenario))
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
  const mandate=assessMandate({asset,resource,contract,responsibility,operation,at});
  const rule=known?{...doc,version:'учебная-1',clause:'Образец, пункт А',territory:'demo',legalClass:asset.legalClass,
    operation:'patrol_plow',clockStart:'snowfall_end',minutes:120}:null;
  const event=known&&request.withEvent===true?{...doc,id:'пример-окончания-снегопада',assetId:edge.id,kind:'snowfall_end',at:new Date(Date.parse(at)+offset*60000).toISOString()}:null;
  const clock=assessClock({asset,operation,rule,event});
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
  const id=JSON.stringify(identity);
  const order={id,dispatchable:routing?.assigned===true};
  let history=[];
  if(!Array.isArray(request.history) || request.history.length>8)throw Error('Проверьте журнал');
  for(const entry of request.history)history=recordStep(order,history,entry);
  const state=history.at(-1)?.state??'planned';
  const actions=order.dispatchable?Object.entries(workflow[state]).map(([state,role])=>({state,role})):[];
  return {mode:'simulation',id,state,history,actions,mandate,clock,routing,asset,responsibility,
    contract,operation,resource,rule,event};
}

