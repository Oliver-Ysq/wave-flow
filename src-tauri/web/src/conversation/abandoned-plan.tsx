/** 放弃的是方案而非任务；下一步只导航/准备草稿，不创建或执行Workflow。 */
export function AbandonedPlan({onRedesign,onTemplate,disabled=false}:{
  /** 聚焦原Task对话；保留已有草稿。 */ onRedesign:()=>void;
  /** 仅首次执行前提供预置入口；缺省不展示。 */ onTemplate?:()=>void;
  /** 主控或执行忙碌时禁用操作；默认false。 */ disabled?:boolean;
}){
 return <section className="abandoned-plan" aria-label="方案已放弃后的下一步">
  <p role="status">此方案已放弃，任务和对话仍保留。</p>
  <small>告诉 Wave Flow 哪里不合适，可以重新设计方案。</small>
  <div><button type="button" disabled={disabled} onClick={onRedesign}>通过对话重新设计</button>{onTemplate&&<button type="button" className="abandoned-plan-secondary" disabled={disabled} onClick={onTemplate}>选择预置方案</button>}</div>
 </section>;
}
