import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registryResponse} from './registry.mjs';

test('register preserves original PDF, asset and old scope across restart; concurrent editors cannot overwrite a revision',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sever-register-'));
  const migration=readFileSync(new URL('../drizzle/0002_responsibility_register.sql',import.meta.url),'utf8');
  function open(){
    const db=new DatabaseSync(join(dir,'dispatch.sqlite'));
    db.exec('PRAGMA foreign_keys=ON;'+migration);return db;
  }
  let db=open();t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const network={version:'net1',edges:[{id:'A',name:'Участок А',geometry:[[1,2],[2,3]]}]};
  const call=(path,body)=>registryResponse(new Request('http://localhost/api/registry'+path,body?{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),db,network);
  const row={contractId:'test/1',edgeId:'A',operation:'patrol_plow',customer:'Учебный заказчик',executor:'Учебный исполнитель',
    reviewer:'А',officer:'Дежурный',source:'Приложение',clause:'п. 1',from:'2026-01-01',until:'2027-01-01',
    objectType:'проезжая часть',jurisdiction:'учебная',owner:'Владелец',balanceHolder:'Служба'};
  const pdf=Buffer.from('%PDF-1.4\ntraining fixture');
  const body={baseRevision:0,sourceUrl:'https://example.org/test',pdfBase64:pdf.toString('base64'),
    file:{mode:'document_review',networkVersion:'net1',rows:[row,{...row,edgeId:'unknown'}]}};
  for(const bad of [{...body,pdfBase64:''},{...body,sourceUrl:''},{...body,file:{...body.file,networkVersion:'other'}},
    {...body,file:{...body.file,rows:[{...row,until:'2025-11-31'}]}}])assert.equal((await call('',bad)).status,400);
  assert.deepEqual(await (await call('')).json(),[]);
  assert.equal((await call('',body)).status,201);
  const next={...body,baseRevision:1,file:{...body.file,rows:[{...row,executor:'Новая служба'}]}};
  const races=await Promise.all([call('',next),call('',next)]);
  assert.deepEqual(races.map(r=>r.status).sort(),[201,409]);
  db.close();db=open();
  const [newer,older]=await (await call('')).json();
  assert.deepEqual([newer.revision,older.revision],[2,1]);
  const q='?contract=test%2F1&revision=';
  const old=await (await call('/revision'+q+1)).json();
  assert.equal(old.rows[0].executor,row.executor);assert.equal(old.rows[1].mapped,0);assert.equal(old.rows[0].mapped,1);
  assert.equal(old.mode,'document_review');assert.equal(old.pdf_digest.length,64);
  assert.equal((await (await call('/revision'+q+2)).json()).rows[0].executor,'Новая служба');
  assert.deepEqual(Buffer.from(await (await call('/document'+q+1)).arrayBuffer()),pdf);
  assert.equal(db.prepare('SELECT count(*) AS n FROM responsibility_documents').get().n,1);
  assert.equal(JSON.parse(db.prepare('SELECT geometry_json FROM responsibility_assets').get().geometry_json).length,2);
});
