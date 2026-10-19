/** 恢复前记录的渐进披露；身份用于读取，界面只展示时间和状态。 */
export function PreviousRecords({current,selected,onSelect,records,part='all'}:{
 /** 顶部只提示旧记录，底部只提供追溯列表；缺省两者均展示。 */part?:'all'|'notice'|'list';
 /** 当前权威运行序号，正整数。 */current:number;
 /** 当前阅读序号，缺省最新。 */selected?:number;
 /** 只改变阅读选择，不恢复执行。 */onSelect:(id:number)=>void;
 /** 已保存记录的时间/状态，缺失时不编造。 */records:readonly {id:number;at?:string;status?:string}[];
}){
 const old=selected!==undefined&&selected!==current;
 return <>
 {part!=='list'&&old&&<p className="previous-record-notice">这是恢复前保存的记录。 <button onClick={()=>onSelect(current)}>查看最新记录</button></p>}
 {part!=='notice'&&current>1&&<details className="previous-records"><summary>恢复前的记录</summary><ul>{Array.from({length:current-1},(_,index)=>index+1).reverse().map(id=>{
 const record=records.find(item=>item.id===id);
 const status=record?.status?({completed:'执行结束',cancelled:'已停止',interrupted:'已中断'} as Record<string,string>)[record.status]??'已保存记录':'已保存记录';
 const time=record?.at?new Date(record.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'时间未保存';
 return <li key={id}><button aria-current={selected===id?'true':undefined} onClick={()=>onSelect(id)}>{time} · {status}</button></li>;
 })}</ul></details>}
 </>;
}
