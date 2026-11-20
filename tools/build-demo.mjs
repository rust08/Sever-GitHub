import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bundleBackend } from './bundle-backend.mjs';

const read=file=>readFileSync(file,'utf8');
const network=read('data/city-network.json');
const packed=gzipSync(network,{level:9}).toString('base64');
const worker=[bundleBackend(),'const compressedNetwork='+JSON.stringify(packed)+';',read('tools/demo-worker.js')].join('\n');
const mime={webp:'image/webp',png:'image/png',jpg:'image/jpeg',svg:'image/svg+xml',json:'application/json',woff2:'font/woff2'};
const assets=new Map();
for(const f of readdirSync('public',{recursive:true,withFileTypes:true})){
  if(!f.isFile())continue;
  const path=join(f.parentPath,f.name), type=mime[f.name.split('.').at(-1)];
  if(type)assets.set('/'+relative('public',path).split('\\').join('/'),'data:'+type+';base64,'+readFileSync(path).toString('base64'));
}
function inlineAssets(text){
  for(const [path,url] of assets)text=text.replaceAll(path,url);
  return text;
}
const safeScript=code=>code.replace(/<\/script/gi,'<\\/script');
const script=(code,attrs='')=>'<script '+attrs+'>'+safeScript(code)+'</script>';
function inlineModule(path,seen=new Set()){
  if(seen.has(path))return '';
  seen.add(path);
  const children=[];
  const body=read(path).replace(/^import\s+[^;]*?from ['"](\.\/[^'"]+)['"];?[ \t]*$/gm,(_,child)=>{
    children.push(inlineModule(join(path,'..',child),seen));return '';
  }).replace(/^export /gm,'');
  return [...children,inlineAssets(body)].join('\n');
}
const app=inlineModule('public/app.js');
let html=read('public/index.html').replace('<html lang="ru"', '<html data-network="'+JSON.parse(network).version+'" lang="ru"');
html=html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,(_,path)=>'<style>'+inlineAssets(read('public'+path))+'</style>');
html=html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g,(_,path)=>path==='/app.js'?'':script(read('public'+path)));
html=html.replace('</body>',()=>[
  '<p hidden id="demo-storage">Смена доступна в этой вкладке. Браузер ограничил её сохранение на устройстве.</p>',
  script(worker,'type="text/plain" id="sever-worker"'),
  script(read('tools/demo-client.js')),script(app,'type="module"'),'</body>'
].join('\n'));
mkdirSync('dist',{recursive:true});
writeFileSync('dist/sever-demo.html',html);
console.log('dist/sever-demo.html · '+(Buffer.byteLength(html)/1024/1024).toFixed(1)+' МБ');
