/** 同一渲染器只加载一次；并发共享Promise，失败释放请求以允许显式重试，成功复用而不存正文。 */
export function createSharedRendererLoader<T>(importer:(attempt:number)=>Promise<T>):()=>Promise<T>{
  let pending:Promise<T>|undefined;
  let attempt=0;
  return ()=>pending??(pending=Promise.resolve().then(()=>importer(attempt++)).catch(error=>{pending=undefined;throw error;}));
}

/** 失败重试使用新模块身份，绕过浏览器ESM失败缓存；仅修改构建器给出的本地地址。 */
export function rendererRequestUrl(url:string,attempt:number):string{return `${url}${url.includes("?")?"&":"?"}wf-render-attempt=${attempt}`;}
