import {useEffect,useId,useRef,useState} from "react";
import {validateAnswer,type SchemaFieldError} from "./schema-support";
import {suggestedParameters} from "./parameter-defaults";
import {ViewCache} from "../workbench-state";
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
  const cached=identity?editors.get(identity):undefined;
  const [value,setValue]=useState(()=>cached?.value??suggestedParameters(schema,initialValue));
  const [listText,setListText]=useState<Record<string,string>>(cached?.listText??{});
  const [errors,setErrors]=useState<SchemaFieldError[]>([]);
  const [failure,setFailure]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);
  const formId=useId(),errorSummary=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(validationErrors){setErrors(validationErrors);if(validationErrors.length)errorSummary.current?.focus();}},[validationErrors]);
  const fields=(schema.properties??{}) as Record<string,Record<string,unknown>>;
  const required=new Set(schema.required as string[]??[]);
  const labels:Record<string,string>={target:"审查范围",focus:"关注重点",maxFindings:"最多问题数",context:"补充背景"};
  function change(key:string,next:unknown,rawList?:string){const updated={...value};if(next===undefined)delete updated[key];else updated[key]=next;const texts=rawList===undefined?listText:{...listText,[key]:rawList};setValue(updated);setListText(texts);if(identity)editors.set(identity,{value:updated,listText:texts});onDraft?.(updated);}
  function field(key:string,node:Record<string,unknown>){
    const type=Array.isArray(node.type)?node.type.find(item=>item!=="null"):node.type;
    const label=String(node.title??labels[key]??key),current=value[key];
    const pointer=`/${key.replace(/~/g,"~0").replace(/\//g,"~1")}`;
    const error=errors.find(item=>item.pointer===pointer||item.pointer?.startsWith(`${pointer}/`))?.message;
    const unsupported=type==="object"||type==="array"&&(node.items as Record<string,unknown>|undefined)?.type!=="string";
    const control=Array.isArray(node.enum)?<select aria-label={label} value={String(current??"")} onChange={event=>change(key,(node.enum as unknown[]).find(item=>String(item)===event.target.value))}><option value="">请选择</option>{node.enum.map((item,index)=><option key={index} value={String(item)}>{String(item)}</option>)}</select>
      :type==="boolean"?<select aria-label={label} value={current===undefined?"":String(current)} onChange={event=>change(key,event.target.value===""?undefined:event.target.value==="true")}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
      :unsupported?<span>复杂参数已保留，请通过主控对话调整。</span>
      :<input id={`${formId}-${key}`} aria-label={label} aria-describedby={error?`${formId}-${key}-error`:undefined} aria-invalid={!!error} type={type==="integer"||type==="number"?"number":"text"} value={type==="array"?(listText[key]??(Array.isArray(current)?current.join("，"):"")):current===undefined||current===null?"":String(current)} placeholder={node.default===undefined?undefined:`建议：${Array.isArray(node.default)?node.default.join("，"):String(node.default)}`} onChange={event=>{const raw=event.target.value;change(key,type==="array"?raw.split(/[，,]/).map(item=>item.trim()).filter(Boolean):type==="integer"||type==="number"?raw===""?undefined:Number(raw):raw,type==="array"?raw:undefined);}}/>;
    return <label key={key} className="compact-parameter-field" onBlur={()=>{if(errors.length)setErrors(validateAnswer(schema,value));}}><span>{label}{required.has(key)&&" *"}</span>{control}{error&&<small id={`${formId}-${key}-error`} role="alert">{error}</small>}</label>;
  }
  async function save(){if(busy||saving||blockedReason)return;const invalid=validateAnswer(schema,value);setErrors(invalid);if(invalid.length){queueMicrotask(()=>errorSummary.current?.focus());return;}setSaving(true);try{await onSubmit(value);setFailure(null);}catch(error){setFailure(error instanceof Error?error.message:String(error));}finally{setSaving(false);}}
  return <section className="compact-parameters" aria-label="参数"><h3>参数</h3><div className="compact-parameter-grid">{Object.entries(fields).filter(([key])=>required.has(key)).map(([key,node])=>field(key,node))}</div>
    {Object.keys(fields).some(key=>!required.has(key))&&<details><summary>更多选项</summary><div className="compact-parameter-grid">{Object.entries(fields).filter(([key])=>!required.has(key)).map(([key,node])=>field(key,node))}</div></details>}
    {blockedReason&&<small role="status">{blockedReason}</small>}
    <div ref={errorSummary} tabIndex={-1}>{errors.length>0&&<small role="alert">请检查参数：{errors.map(error=>`${labels[error.path]??error.path} ${error.message}`).join("；")}</small>}</div>
    <button type="button" className="button-secondary" disabled={busy||saving||!!blockedReason} onClick={()=>void save()}>{saving?"正在保存…":submitLabel}</button>{failure&&<small role="alert">{failure}</small>}
  </section>;
}
