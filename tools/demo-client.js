// A dedicated worker keeps the city map interactive during planning.
{
  const source=document.getElementById('sever-worker').textContent;
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  const worker=new Worker(url);
  const pending=new Map();
  let sequence=0, failed, saved=null;
  const storageKey='sever-demo:'+document.documentElement.dataset.network;
  try{saved=JSON.parse(localStorage.getItem(storageKey));}catch{}
  worker.onmessage=({data})=>{
    const request=pending.get(data.seq);
    if(!request)return;
    pending.delete(data.seq);
    if(data.error){request.reject(new Error(data.error));return;}
    if(data.stored){
      saved=data.stored;
      try{localStorage.setItem(storageKey,JSON.stringify(saved));}catch{
        const notice=document.getElementById('demo-storage');
        notice.hidden=false;
      }
    }
    request.resolve(data.value);
  };
  worker.onerror=()=>{
    failed=new Error('Браузер не смог запустить расчёт. Откройте этот файл в современном Chrome или Edge.');
    for(const request of pending.values())request.reject(failed);
    pending.clear();
  };
  globalThis.severDemo={request(path,input){
    if(failed)return Promise.reject(failed);
    return new Promise((resolve,reject)=>{
      const seq=++sequence;
      pending.set(seq,{resolve,reject});
      worker.postMessage({seq,path,input,snapshot:path==='/api/data'?saved:null});
    });
  }};
}
