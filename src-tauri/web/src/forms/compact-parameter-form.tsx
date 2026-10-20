import {useContext,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {WorkflowSourceActions} from "../workflow-source-dialog";
import {validateAnswer,type SchemaFieldError} from "./schema-support";
import {suggestedParameters} from "./parameter-defaults";
import {ViewCache} from "../workbench-state";
import {parameterGroups,parameterErrorKey,parameterErrorMessage} from "./parameter-presentation";
const editors=new ViewCache<{value:Record<string,unknown>;listText:Record<string,string>}>(64);

/** 紧凑业务参数编辑：存储Schema继续权威校验，不向用户展示JSON类型树。 */
export function CompactParameterForm({schema,initialValue={},busy=false,blockedReason,onSubmit,onDraft,submitLabel="保存待运行",identity,validationErrors}:{
  /** 最终运行校验错误，同步到字段；缺省由表单保存自行校验。 */ validationErrors?:SchemaFieldError[];
  /** 冻结模板输入契约，默认值仅作为建议，不绕过校验。 */ schema:Record<string,unknown>;
  /** 当前已保存/主控整理的参数；缺省为空对象。 */ initialValue?:Record<string,unknown>;
  /** 显式保存请求处理中。 */ busy?:boolean;
  /** 主控/执行占用时只禁提交，不删除输入。 */ blockedReason?:string;
  /** Schema校验通过后的保存，不自动执行。 */ onSubmit:(input:Record<string,unknown>)=>Promise<void>;
  /** 会话内草稿变化，不构成批准。 */ onDraft?:(input:Record<string,unknown>)=>void;
  /** 主动作文案，缺省保存待运行。 */ submitLabel?:string;
  /** 兼容父级稳定表单身份，由父级key管理挂载。 */ identity?:string;
}){
  const actionSlot=useContext(WorkflowSourceActions);
  const cached=identity?editors.get(identity):undefined;
  const [value,setValue]=useState(()=>cached?.value??suggestedParameters(schema,initialValue));
  const [listText,setListText]=useState<Record<string,string>>(cached?.listText??{});
  const [errors,setErrors]=useState<SchemaFieldError[]>(validationErrors??[]);
  const [failure,setFailure]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);
  const formId=useId(),errorSummary=useRef<HTMLElement>(null),optionalDetails=useRef<HTMLDetailsElement>(null),section=useRef<HTMLElement>(null),pendingErrorFocus=useRef<SchemaFieldError[]|null>(null);
  const touched=useRef(new Set<string>()),submitted=useRef(false);
  const fields=(schema.properties??{}) as Record<string,Record<string,unknown>>;
  const requiredKeys=(schema.required as string[]??[]).filter(key=>fields[key]);
  const required=new Set(requiredKeys);
  const {primary:primaryKeys,advanced:optionalKeys}=useMemo(()=>parameterGroups(schema),[schema]);
  const [advancedOpen,setAdvancedOpen]=useState(()=>!!validationErrors?.some(error=>optionalKeys.includes(parameterErrorKey(error,fields)??"")));
  const labels:Record<string,string>={target:"审查范围",focus:"关注重点",maxFindings:"最多问题数",context:"补充背景"};
  function errorKey(error:SchemaFieldError){
    return parameterErrorKey(error,fields);
  }
  function errorTarget(error:SchemaFieldError){
    const key=errorKey(error),node=key===undefined?undefined:fields[key];
    if(!node)return undefined;
    const type=Array.isArray(node.type)?node.type.find(item=>item!=="null"):node.type;
    return Array.isArray(node.enum)||["string","number","integer","boolean"].includes(String(type))||type==="array"&&(node.items as Record<string,unknown>|undefined)?.type==="string"?key:undefined;
  }
  function goToError(error:SchemaFieldError){
    const key=errorTarget(error);
    if(key===undefined)return;
    if(optionalKeys.includes(key))setAdvancedOpen(true);
    requestAnimationFrame(()=>{
      const control=document.getElementById(`${formId}-${key}`);
      if(control&&section.current?.contains(control))control.focus();
    });
  }
  function focusErrors(next:SchemaFieldError[]){
    if(!next.length)return;
    const hasOptionalError=next.some(item=>{
      const key=errorKey(item);
      return key!==undefined&&optionalKeys.includes(key);
    });
    if(hasOptionalError)setAdvancedOpen(true);
    pendingErrorFocus.current=next;
  }
  useLayoutEffect(()=>{
    const next=pendingErrorFocus.current;
    if(!next)return;
    const frame=requestAnimationFrame(()=>{
      pendingErrorFocus.current=null;
      // 同一字段可能同时触发type/enum等多个AJV错误；摘要按字段去重，焦点也须
      // 以实际摘要是否存在为准，否则会尝试聚焦不存在的摘要而遗漏首个错误。
      // WKWebView 对 <summary> 的程序化聚焦不可靠：必须回读 activeElement，
      // 没有真正接住焦点时退回首个可见的 aria-invalid 控件。
      const summary=errorSummary.current;
      if(summary){summary.focus();if(document.activeElement===summary)return;}
      const controls=[...section.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]')??[]];
      const control=controls.find(item=>item.getClientRects().length>0);
      (control??summary)?.focus();
    });
    return()=>cancelAnimationFrame(frame);
  });
  useEffect(()=>{if(validationErrors){submitted.current=true;setErrors(validationErrors);focusErrors(validationErrors);}},[validationErrors]);
  function blurField(key:string){
    touched.current.add(key);
    const next=validateAnswer(schema,value);
    setErrors(submitted.current?next:next.filter(error=>touched.current.has(errorKey(error)??"")));
  }
  function message(error:SchemaFieldError){const key=errorKey(error);return parameterErrorMessage(error,key===undefined?undefined:fields[key],key===undefined?error.path:String(fields[key]?.title??labels[key]??key),key===undefined?value:value[key]);}
  function change(key:string,next:unknown,rawList?:string){const updated={...value};if(next===undefined)delete updated[key];else updated[key]=next;const texts=rawList===undefined?listText:{...listText,[key]:rawList};setValue(updated);setListText(texts);if(identity)editors.set(identity,{value:updated,listText:texts});onDraft?.(updated);
    // 选择/输入本身就是对该字段的编辑：立刻重算它的错误，而不是等到失焦或再次
    // 提交，否则已填好的枚举仍显示“必填字段未填写”。
    touched.current.add(key);
    const nextErrors=validateAnswer(schema,updated);
    setErrors(submitted.current?nextErrors:nextErrors.filter(error=>touched.current.has(errorKey(error)??"")));
  }
  function field(key:string,node:Record<string,unknown>){
    const type=Array.isArray(node.type)?node.type.find(item=>item!=="null"):node.type;
    const label=String(node.title??labels[key]??key),current=value[key];
    const pointer=`/${key.replace(/~/g,"~0").replace(/\//g,"~1")}`;
    const issue=errors.find(item=>item.pointer===pointer||item.pointer?.startsWith(`${pointer}/`));
    const error=issue?message(issue):undefined;
    const unsupported=type==="object"||type==="array"&&(node.items as Record<string,unknown>|undefined)?.type!=="string";
    const control=Array.isArray(node.enum)?<select id={`${formId}-${key}`} aria-label={label} aria-describedby={error?`${formId}-${key}-error`:undefined} aria-invalid={!!error} value={String(current??"")} onChange={event=>change(key,(node.enum as unknown[]).find(item=>String(item)===event.target.value))}><option value="">请选择</option>{node.enum.map((item,index)=><option key={index} value={String(item)}>{String(item)}</option>)}</select>
      :type==="boolean"?<select id={`${formId}-${key}`} aria-label={label} aria-describedby={error?`${formId}-${key}-error`:undefined} aria-invalid={!!error} value={current===undefined?"":String(current)} onChange={event=>change(key,event.target.value===""?undefined:event.target.value==="true")}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
      :unsupported?<span>复杂参数已保留，请在对话中让 Wave Flow 调整。</span>
      :<input id={`${formId}-${key}`} aria-label={label} aria-describedby={error?`${formId}-${key}-error`:undefined} aria-invalid={!!error} type={type==="integer"||type==="number"?"number":"text"} value={type==="array"?(listText[key]??(Array.isArray(current)?current.join("，"):"")):current===undefined||current===null?"":String(current)} placeholder={node.default===undefined?undefined:`建议：${Array.isArray(node.default)?node.default.join("，"):String(node.default)}`} onChange={event=>{const raw=event.target.value;change(key,type==="array"?raw.split(/[，,]/).map(item=>item.trim()).filter(Boolean):type==="integer"||type==="number"?raw===""?undefined:Number(raw):raw,type==="array"?raw:undefined);}}/>;
    return <label key={key} className="compact-parameter-field" onBlur={()=>blurField(key)}><span>{label}{required.has(key)&&" *"}</span>{control}{error&&<small id={`${formId}-${key}-error`} role="alert">{error}</small>}</label>;
  }
  async function save(){if(busy||saving||blockedReason)return;submitted.current=true;const invalid=validateAnswer(schema,value);setErrors(invalid);if(invalid.length){focusErrors(invalid);return;}setSaving(true);try{await onSubmit(value);setFailure(null);}catch(error){setFailure(error instanceof Error?error.message:String(error));}finally{setSaving(false);}}
  // 鼠标按下不先让字段失焦：失焦校验插入摘要会移动按钮，导致松开时丢失click。
  // 完整点击仍统一校验；Tab/Enter路径不阻止，键盘焦点顺序保持原样。
  const action=<button type="button" className="button-secondary source-save-action" disabled={busy||saving||!!blockedReason} onMouseDown={event=>event.preventDefault()} onClick={()=>void save()}>{saving?"正在保存…":submitLabel}</button>;
  const issues=[...new Map(errors.map(error=>[errorKey(error)??error.path,error])).values()];
  const advancedErrors=issues.filter(error=>optionalKeys.includes(errorKey(error)??"")).length;
  const adjusted=optionalKeys.filter(key=>Object.hasOwn(value,key)&&JSON.stringify(value[key])!==JSON.stringify(fields[key].default)).length;
  return <section ref={section} className="compact-parameters" aria-label="参数"><h3>参数</h3>
    {(issues.length>1||issues.some(error=>errorTarget(error)===undefined))&&<details className="parameter-error-summary"><summary ref={errorSummary} tabIndex={-1}>还有 {issues.length} 项需要填写或修改 <span>查看</span></summary><ul>{issues.map((error,index)=>{
        const key=errorKey(error),target=errorTarget(error),label=key===undefined?error.path:String(fields[key]?.title??labels[key]??key);
        const text=`${label?`${label}：`:""}${message(error)}`;
        return <li key={index}>{target===undefined?<span>{text}</span>:<a href={`#${formId}-${target}`} onClick={event=>{event.preventDefault();goToError(error);}}>{text}</a>}</li>;
      })}</ul></details>}
    {primaryKeys.length>0&&<div className="compact-parameter-grid">{primaryKeys.map(key=>field(key,fields[key]!))}</div>}
    {optionalKeys.length>0&&<details ref={optionalDetails} className="parameter-advanced" open={advancedOpen} onToggle={event=>setAdvancedOpen(event.currentTarget.open)}><summary>高级设置{advancedErrors>0?<span>有 {advancedErrors} 项错误</span>:adjusted>0?<span>已调整 {adjusted} 项</span>:<span>可选</span>}</summary><div className="compact-parameter-grid">{optionalKeys.map(key=>field(key,fields[key]!))}</div></details>}
    {blockedReason&&<small role="status">{blockedReason}</small>}
    {actionSlot?createPortal(action,actionSlot):action}{failure&&<small role="alert">{failure}</small>}
  </section>;
}
