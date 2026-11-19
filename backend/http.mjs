import {api,InputError} from './service.mjs';
export async function handle(request,db,asset,data) {
  const url=new URL(request.url), path=url.pathname;
  if (!path.startsWith('/api/')) {
    if (request.method!=='GET') return new Response(null,{status:405});
    const file=await asset(path==='/'?'/index.html':path);
    if(!file)return new Response('Страница не найдена',{status:404});
    file.headers.set('Cache-Control','no-cache');
    return file;
  }
  try {
    let input;
    if (request.method==='POST') {
      if(!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({error:'Требуется JSON'},{status:415});
      const raw=await request.text();
      if(new TextEncoder().encode(raw).length>2*1024*1024) return Response.json({error:'Параметры смены превышают 2 МБ'},{status:413});
      try {input=JSON.parse(raw)} catch {throw new InputError('Некорректный JSON')}
    }
    const value=await api(db,request.method,path,input,data);
    if(!value) return Response.json({error:'Ресурс не найден'},{status:404});
    return Response.json(value,{status:request.method==='POST'?201:200,headers:{'Cache-Control':'no-store'}});
  } catch(e) {
    if(e instanceof InputError) return Response.json({error:e.message},{status:400});
    console.error(e);
    return Response.json({error:'Не удалось выполнить операцию с планом смены'},{status:500});
  }
}
