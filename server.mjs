import {journalResponse} from './backend/execution-journal.mjs';
import {registryResponse} from './backend/registry.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCatalog} from './backend/service.mjs';
import {handle} from './backend/http.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const directory=process.env.SNOW_DB_DIR || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA,'SnowControlKamchatka') : join(root,'runtime'));
mkdirSync(directory,{recursive:true});
const sqlite=new DatabaseSync(join(directory,'dispatch.sqlite'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
for (const file of readdirSync(join(root,'drizzle')).filter(f=>f.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(join(root,'drizzle',file),'utf8'));
}
const db={
  rows:(sql,args=[])=>sqlite.prepare(sql).all(...args),
  batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { for (const [sql,args] of statements) sqlite.prepare(sql).run(...args); sqlite.exec('COMMIT'); }
    catch(e){ sqlite.exec('ROLLBACK'); throw e; }
  }
};
const data=createCatalog(JSON.parse(readFileSync(join(root,'data/city-network.json'),'utf8')));
const publicDir=join(root,'public');
const mime={html:'text/html',js:'text/javascript',css:'text/css',txt:'text/plain',png:'image/png',webp:'image/webp',svg:'image/svg+xml',jpg:'image/jpeg',json:'application/json'};
const files=new Set(readdirSync(publicDir,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name).slice(publicDir.length).replaceAll('\\','/')));
function asset(path) {
  if(!files.has(path)) return null;
  return new Response(readFileSync(join(publicDir,path)),{headers:{'content-type':mime[path.split('.').at(-1)]||'application/octet-stream'}});
}
const port=Number(process.env.PORT||8792);
const launch=process.platform==='win32' && process.argv.includes('--open');
let attemptPort=port;
function address(){return 'http://127.0.0.1:'+attemptPort}
function openBrowser(){spawn('rundll32.exe',['url.dll,FileProtocolHandler',address()],{windowsHide:true,detached:true,stdio:'ignore'}).unref()}
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/api/version'){res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});return res.end('sever-city-dark-1')}
    const registry=req.url.split('?')[0].startsWith('/api/registry');
    const journal=req.url.split('?')[0].startsWith('/api/work-orders');
    if(registry || journal || req.method!=='GET'){
      const host=req.headers.host??'';
      if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) || (req.headers.origin && req.headers.origin!=='http://'+host)){
        res.writeHead(403);return res.end();
      }
    }
    const chunks=[]; let bytes=0;
    for await (const chunk of req) {bytes+=chunk.length;if(bytes>(registry?18:2)*1024*1024){res.writeHead(413);return res.end()} chunks.push(chunk)}
    const request=new Request(new URL(req.url,'http://127.0.0.1'),{method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined});
    const response=journal?await journalResponse(request,sqlite,data):registry?await registryResponse(request,sqlite,data.network):await handle(request,db,asset,data);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch(e) {console.error(e);res.writeHead(500);res.end()}
});
server.on('listening',()=>{attemptPort=server.address().port;console.log(address());if(launch)openBrowser()});
server.on('error',async error=>{
  if(!launch || error.code!=='EADDRINUSE')throw error;
  try {
    const response=await fetch(address()+'/api/version',{signal:AbortSignal.timeout(1500)});
    if(await response.text()==='sever-city-dark-1'){openBrowser();sqlite.close();return}
  }catch{}
  attemptPort++;
  if(attemptPort>port+10)throw Error('Нет свободного порта для сайта');
  server.listen(attemptPort,'127.0.0.1');
});
server.listen(port,'127.0.0.1');
