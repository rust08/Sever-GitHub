import {createHash} from 'node:crypto';
import {workTypes} from './governance.mjs';

class RegistryError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
const fail=message=>{throw new RegistryError(message);};
const validText=v=>typeof v==='string' && v===v.trim() && v.length>0 && v.length<=240;
function validDay(v){
  return typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().startsWith(v+'T');
}
function saveRevision(db,network,body){
  const {file,baseRevision,pdfBase64,sourceUrl=''}=body??{};
  if(!file || !['simulation','document_review'].includes(file.mode) || file.networkVersion!==network.version ||
     !Array.isArray(file.rows) || !file.rows.length || file.rows.length>100 || !Number.isSafeInteger(baseRevision) || baseRevision<0)
    fail('Проверьте режим, версию сети, базовую редакцию и количество строк (1–100)');
  const contract=file.rows[0]?.contractId;
  const fields=['edgeId','customer','executor','officer','contractId','source','clause','reviewer'];
  for(const [i,row] of file.rows.entries()){
    if(row?.worksite!==undefined){
      const limits=row.worksite;
      if(!limits || typeof limits!=='object' || Array.isArray(limits) || Object.entries(limits).some(([key,value])=>
        !['clearWidthM','maxMassT','gradePct'].includes(key) || !Number.isFinite(value) || (key==='gradePct'?value<0:value<=0)))
        fail('Проверьте ограничения участка в строке '+(i+1));
    }
    const assetFields=['objectType','jurisdiction','owner','balanceHolder'];
    if(row && assetFields.some(k=>(file.mode==='document_review' || row[k]!==undefined) && !validText(row[k])))fail('Укажите тип объекта, юрисдикцию, владельца и балансодержателя в строке '+(i+1));
    if(!row || fields.some(k=>!validText(row[k])) || row.contractId!==contract || !Object.hasOwn(workTypes,row.operation) ||
       !validDay(row.from) || !validDay(row.until) || row.from>=row.until)fail('Проверьте договор, поля и даты строки '+(i+1));
  }
  if(typeof sourceUrl!=='string' || sourceUrl.length>2000 || (sourceUrl && !/^https:\/\//i.test(sourceUrl)))fail('Нужна HTTPS-ссылка на источник');
  if(sourceUrl && !URL.canParse(sourceUrl))fail('Некорректная ссылка');
  let pdf=null,digest=null;
  if(pdfBase64){
    if(typeof pdfBase64!=='string' || pdfBase64.length>16*1024*1024)fail('PDF превышает разрешённый размер');
    pdf=Buffer.from(pdfBase64,'base64');
    if(pdf.toString('base64')!==pdfBase64 || pdf.subarray(0,5).toString()!=='%PDF-')fail('Проверьте формат PDF');
    digest=createHash('sha256').update(pdf).digest('hex');
  }
  if(file.mode==='document_review' && (!digest || !sourceUrl))fail('Для документальной проверки нужны PDF и ссылка на источник');
  const networkEdges=new Map(network.edges.map(e=>[e.id,e]));
  db.exec('BEGIN IMMEDIATE');
  try{
    const prev=db.prepare('SELECT revision,mode FROM responsibility_revisions WHERE contract_id=? ORDER BY revision DESC LIMIT 1').get(contract);
    if((prev?.revision??0)!==baseRevision || (prev && prev.mode!==file.mode))throw new RegistryError('Редакция или режим изменились. Откройте актуальную версию и сверьте изменения.',409);
    const revision=baseRevision+1;
    if(digest)db.prepare('INSERT OR IGNORE INTO responsibility_documents VALUES(?,?)').run(digest,pdf);
    db.prepare('INSERT INTO responsibility_revisions VALUES(?,?,?,?,?,?,?)').run(contract,revision,file.mode,network.version,new Date().toISOString(),sourceUrl,digest);
    const insert=db.prepare('INSERT INTO responsibility_scope_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    file.rows.forEach((row,i)=>{
      const edge=networkEdges.get(row.edgeId);
      if(edge){
        const geometry=edge.geometry?.coordinates??edge.geometry??[network.nodes[edge.from],network.nodes[edge.to]];
        db.prepare('INSERT OR IGNORE INTO responsibility_assets VALUES(?,?,?)').run(network.version,edge.id,JSON.stringify(geometry));
      }
      insert.run(contract,revision,i+1,row.edgeId,edge?.name??null,Number(Boolean(edge)),row.operation,row.customer,row.executor,
        row.officer,row.source,row.clause,row.reviewer,row.from,row.until,row.objectType??'не указан',row.jurisdiction??'не указана',row.owner??'не указан',row.balanceHolder??'не указан');
      if(row.worksite && Object.keys(row.worksite).length)
        db.prepare('INSERT INTO responsibility_worksites VALUES(?,?,?,?)').run(contract,revision,i+1,JSON.stringify(row.worksite));
    });
    db.exec('COMMIT');return {contract_id:contract,revision};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
function readCoverage(db,network,params){
  const date=params.get('date'),operation=params.get('operation'),mode=params.get('mode');
  const cutoff=params.get('asOf')??new Date().toISOString();
  if(!validDay(date) || !Object.hasOwn(workTypes,operation) || !['simulation','document_review'].includes(mode) ||
     !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString()!==cutoff)
    fail('Проверьте дату работ, операцию, тип записей и момент среза');
  const rows=db.prepare(`
    WITH latest AS (
      SELECT contract_id,MAX(revision) AS revision FROM responsibility_revisions
      WHERE recorded_at<=? GROUP BY contract_id
    )
    SELECT s.edge_id,s.mapped,s.contract_id,s.revision,s.line,s.executor,s.source,s.clause
    FROM latest JOIN responsibility_revisions r USING(contract_id,revision)
    JOIN responsibility_scope_rows s USING(contract_id,revision)
    WHERE r.network_version=? AND r.mode=? AND s.operation=? AND s.date_from<=? AND ?<s.date_until
    ORDER BY s.edge_id,s.contract_id,s.line
  `).all(cutoff,network.version,mode,operation,date,date);
  const groups=new Map(),unmapped=[];
  for(const row of rows){
    if(!row.mapped){unmapped.push(row);continue;}
    if(!groups.has(row.edge_id))groups.set(row.edge_id,[]);
    groups.get(row.edge_id).push(row);
  }
  const stats={};
  for(const key of ['unknown','single','overlap'])stats[key]={edges:0,km:0};
  for(const edge of network.edges){
    const count=groups.get(edge.id)?.length??0;
    const bucket=stats[count>1?'overlap':count?'single':'unknown'];
    bucket.edges++;bucket.km+=edge.km;
  }
  return {networkVersion:network.version,date,operation,mode,asOf:cutoff,stats,entries:[...groups],unmapped};
}

export async function registryResponse(request,db,network){
  const url=new URL(request.url);
  const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  try{
    if(request.method==='POST' && url.pathname==='/api/registry'){
      if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Требуется JSON'},415);
      let body;try{body=await request.json();}catch{fail('Некорректный JSON');}
      return json(saveRevision(db,network,body),201);
    }
    if(request.method!=='GET')return json({error:'Метод недоступен'},405);
    if(url.pathname==='/api/registry/coverage')return json(readCoverage(db,network,url.searchParams));
    if(url.pathname==='/api/registry')return json(db.prepare('SELECT contract_id,revision,mode,recorded_at FROM responsibility_revisions ORDER BY contract_id,revision DESC').all());
    const contract=url.searchParams.get('contract'), revision=Number(url.searchParams.get('revision'));
    const record=db.prepare('SELECT * FROM responsibility_revisions WHERE contract_id=? AND revision=?').get(contract,revision);
    if(!record)return json({error:'Редакция не найдена'},404);
    if(url.pathname==='/api/registry/document' && record.pdf_digest){
      const {content}=db.prepare('SELECT content FROM responsibility_documents WHERE digest=?').get(record.pdf_digest);
      return new Response(content,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="scope.pdf"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(url.pathname!=='/api/registry/revision')return json({error:'Ресурс не найден'},404);
    const rows=db.prepare(`SELECT s.*,w.limits_json FROM responsibility_scope_rows s
      LEFT JOIN responsibility_worksites w USING(contract_id,revision,line)
      WHERE s.contract_id=? AND s.revision=? ORDER BY line`).all(contract,revision)
      .map(({limits_json,...row})=>limits_json?{...row,worksite:JSON.parse(limits_json)}:row);
    return json({...record,rows});
  }catch(e){if(e instanceof RegistryError)return json({error:e.message},e.status);throw e;}
}
