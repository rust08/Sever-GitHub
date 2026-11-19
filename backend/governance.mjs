// These decisions support a simulation. Import of verified operational records is a separate milestone.
export const workTypes = Object.freeze({
  patrol_plow:'Патрульная расчистка', full_width_clear:'Расчистка на полную ширину',
  anti_icing:'Противогололёдная обработка', berm_opening:'Разрыв снежного вала',
  snow_load:'Погрузка', snow_haul:'Вывоз', snow_unload:'Разгрузка',
  sidewalk:'Уборка тротуара', stairs:'Уборка лестницы', stop_cleaning:'Уборка остановки',
  drain_clear:'Очистка водоотвода', ice_breaking:'Удаление наледи'
});
const dated = value => typeof value==='string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
function documented(record) {
  return record?.status==='checked' && typeof record.document==='string' && record.document.trim().length>0;
}
function effective(record,at) {
  return dated(at) && dated(record?.start) && dated(record?.end) &&
    Date.parse(record.start)<=Date.parse(at) && Date.parse(at)<Date.parse(record.end);
}

export function assessMandate({asset,responsibility,contract,resource,operation,at,site}) {
  const missing=[], conflicts=[];
  if(!asset?.id || !documented(asset) || !asset.owner || !asset.balanceHolder)missing.push('Паспорт объекта, владелец и балансодержатель');
  if(!documented(responsibility) || !responsibility.authority || !responsibility.officer || !responsibility.executor)
    missing.push('Ответственное лицо, орган и основание полномочий');
  else if(responsibility.assetId!==asset?.id || !responsibility.operations?.includes(operation) || !effective(responsibility,at))
    conflicts.push('Полномочия не охватывают объект, операцию или дату');
  if(!documented(contract))missing.push('Договор и адресное приложение с перечнем работ');
  else if(!effective(contract,at) || !contract.assets?.includes(asset?.id) || !contract.operations?.includes(operation) ||
    contract.executor!==responsibility?.executor || contract.customer!==responsibility?.authority)
    conflicts.push('Работа вне границ, сторон или периода договора');
  if(!documented(resource) || !resource.id || resource.permitted==null)missing.push('Карточка техники и допуск');
  else if(resource.permitted!==true || resource.executor!==responsibility?.executor || !resource.operations?.includes(operation))
    conflicts.push('Техника или допуск не соответствуют работе');
  if(['snow_haul','snow_unload'].includes(operation) && (!documented(site) || site.permitted!==true))missing.push('Разрешённая площадка приёма снега');
  if(!Object.hasOwn(workTypes,operation))conflicts.push('Неизвестный вид работ');
  return {status:conflicts.length?'blocked':missing.length?'manual_review':'eligible',missing,conflicts};
}

export function assessClock({asset,operation,rule,event}) {
  if(!documented(rule) || !rule.version || !rule.clause || !asset?.legalClass || asset.legalClass!==rule.legalClass ||
    asset.territory!==rule.territory || rule.operation!==operation || !(rule.minutes>0) || !Number.isFinite(rule.minutes))
    return {status:'needs_review'};
  if(!documented(event) || !event.id || !dated(event.at) || event.kind!==rule.clockStart || event.assetId!==asset.id)
    return {status:'clock_unknown'};
  if(!effective(rule,event.at))return {status:'needs_review'};
  return {status:'scenario_deadline',originEventId:event.id,ruleVersion:rule.version,
    dueAt:new Date(Date.parse(event.at)+rule.minutes*60000).toISOString()};
}

export const workflow = {
  planned:{dispatched:'dispatcher'},dispatched:{started:'operator'},
  started:{machine_reported:'operator'},machine_reported:{inspector_verified:'inspector',rejected:'inspector'},
  inspector_verified:{accepted:'customer',rejected:'customer'},rejected:{disputed:'executor'},disputed:{},accepted:{}
};
export function recordStep(order,history,entry) {
  const previous=history.at(-1);
  const status=previous?.state || 'planned';
  if(entry.orderId!==order.id || !Object.hasOwn(workflow[status],entry.state) || workflow[status][entry.state]!==entry.role)
    throw Error('Недопустимый переход или роль');
  if(entry.state==='dispatched' && !order.dispatchable)throw Error('Сначала нужны допуск и маршрут');
  if(!entry.actor?.trim() || !dated(entry.at) || (previous && Date.parse(entry.at)<Date.parse(previous.at)))
    throw Error('Проверьте автора и время записи');
  if(!entry.evidence?.trim() || entry.evidenceKind==='gps')throw Error('Нужна запись о конкретной операции');
  return [...history,{...entry}];
}

