import {test,expect} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {visibleVersion,versionLabel,WorkflowVersions} from '../../src-tauri/web/src/conversation/workflow-versions';
import type {LeadSnapshot,WorkflowRevision} from '../../src-tauri/web/src/types';
import {WorkflowRevisionCard} from '../../src-tauri/web/src/conversation/revision-card';
import {WorkflowDesign} from '../../src-tauri/web/src/workflow-design';
test('五个独立工作流不显示任务累计版本，同工作流排序不改内部身份',()=>{
 const revisions=Array.from({length:5},(_,i)=>({revision:i+1,cardId:`card-${i}`,parentRevision:null})) as WorkflowRevision[];
 const task={workflowRevisions:revisions} as LeadSnapshot;
 expect(revisions.map(item=>visibleVersion(task,item))).toEqual([null,null,null,null,null]);
 expect(renderToStaticMarkup(<WorkflowVersions versions={[revisions[4]!]} selected={5} onSelect={()=>{}}/>)).toBe('');
 const added={...revisions[4]!,revision:9,parentRevision:5};
 const changed={...task,workflowRevisions:[...revisions,added]};
 expect(visibleVersion(changed,revisions[4]!)).toBe(1);expect(visibleVersion(changed,added)).toBe(2);
 expect(versionLabel(changed,revisions[4]!)).toBe('历史版本 · 第 1 版');
 expect(versionLabel(changed,added)).toBe('当前版本 · 第 2 版');
 expect(versionLabel(task,revisions[0]!)).toBeNull();
 const html=renderToStaticMarkup(<WorkflowVersions versions={[revisions[4]!,added]} selected={9} onSelect={()=>{}}/>);
 expect(html).toContain('历史版本');expect(html).toContain('第 2 版');expect(html).not.toContain('第 9 版');
});
test('最新版正文标签不是历史，旧版保持历史且不同工作流互不影响',()=>{
 const base={cardId:'one',source:'',sourceHash:'hash',createdAt:'2026-10-18T00:00:00Z',acceptedAt:null,goal:'工作目标',scope:'只读'};
 const old={...base,revision:2},current={...base,revision:7};
 const task={leadRunId:'task',status:'idle',workflowRevisions:[old,current,{...base,cardId:'other',revision:9}],executions:[],task:{},impactSummaries:[],messages:[],conversationEntries:[]} as unknown as LeadSnapshot;
 const render=(revision:WorkflowRevision)=>renderToStaticMarkup(<WorkflowRevisionCard revision={revision} lead={task} onAssignmentCreated={()=>{}}/>);
 expect(render(current)).toContain('当前版本 · 第 2 版');
 expect(render(current)).not.toContain('历史版本 · 第 2 版');
 expect(render(old)).toContain('历史版本 · 第 1 版');
});
test('未执行旧版CLI按原声明展示，不暗示等待后可以选择',()=>{
 const revision={revision:2,cardId:'one',preview:{phaseTitles:['检查'],previewAgents:[{key:'check',nodeId:'check',name:'检查',cli:'codex',phaseTitle:'检查'}]}} as unknown as WorkflowRevision;
 const html=renderToStaticMarkup(<WorkflowDesign taskId="task" revision={revision} editable={false} onCreated={()=>{}}/>);
 expect(html).toContain('Codex CLI');expect(html).not.toContain('源码声明');
 expect(html).not.toContain('处理结束后');expect(html).not.toContain('<select');
});
test('单版本正文上方不重复方案标签，多版本仍显示历史版本',()=>{
 const revision={revision:5,cardId:'one',source:'',sourceHash:'hash',createdAt:'2026-10-18T00:00:00Z',acceptedAt:null,rejectedAt:null,goal:'工作目标',scope:'只读'} as WorkflowRevision;
 const task={leadRunId:'task',status:'idle',workflowRevisions:[revision],executions:[],task:{},impactSummaries:[],messages:[],conversationEntries:[]} as unknown as LeadSnapshot;
 const html=renderToStaticMarkup(<WorkflowRevisionCard revision={revision} lead={task} onAssignmentCreated={()=>{}}/>);
 expect(html).not.toContain('<span>方案</span>');expect(html).not.toContain('第 5 版');
});
