import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {bundleBackend} from './tools/bundle-backend.mjs';
const read=path=>readFileSync(path,'utf8');
const body=bundleBackend();
const assets={};
for(const entry of readdirSync('public',{recursive:true,withFileTypes:true}).filter(e=>e.isFile())){
  const file=join(entry.parentPath,entry.name), key='/'+relative('public',file).split('\\').join('/');
  assets[key]=key.endsWith('.webp')?readFileSync(file).toString('base64'):read(file);
}
const worker=body+'\nconst seedNetwork='+read('data/city-network.json')+';\nconst assets='+JSON.stringify(assets)+';\n'+read('backend/worker-entry.txt');
mkdirSync('dist/server',{recursive:true});mkdirSync('dist/.openai',{recursive:true});
writeFileSync('dist/server/index.js',worker);
copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
await import('./dist/server/index.js');
