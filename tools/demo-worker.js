// These functions and the compressed network are embedded by build-demo.mjs.
let catalogPromise;
async function loadCatalog() {
  const bytes=Uint8Array.from(atob(compressedNetwork), c=>c.charCodeAt(0));
  const json=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return createCatalog(await new Response(json).json());
}
self.onmessage=async ({data:message})=>{
  const {seq,path,input,snapshot}=message;
  try {
    catalogPromise ??= loadCatalog();
    const catalog=await catalogPromise;
    if(path==='/api/data'){
      let latest=null;
      if(snapshot?.version===catalog.network.version){
        latest={id:snapshot.id,input:snapshot.input,result:await decodeShiftResult(snapshot.result)};
      }
      self.postMessage({seq,value:{...catalog,latest}});
    }else if(path==='/api/unified-shifts/preview'){
      self.postMessage({seq,value:await api(null,'POST',path,input,catalog)});
    }else if(path==='/api/haul/preview'){
      self.postMessage({seq,value:evaluateHaul(catalog,input)});
    }else if(path==='/api/orders/preview'){
      self.postMessage({seq,value:evaluateOrder(catalog,input)});
    }else if(path==='/api/plans'){
      const value=calculateShift(catalog,input);
      const stored={version:catalog.network.version,id:value.id,input:value.input,result:await encodeShiftResult(value.result)};
      self.postMessage({seq,value,stored});
    }else throw new Error('Неизвестная операция');
  }catch(error){self.postMessage({seq,error:error.message});}
};
