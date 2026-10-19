import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {groupPlanUpdates,planUpdateLabel,TimelineRecords,type TimelineItem} from '../../src-tauri/web/src/conversation/plan-updates';
import type {WorkflowRevision} from '../../src-tauri/web/src/types';
const item=(key:string,update?:string):TimelineItem=>({key,at:key,content:<button>{key}</button>,planUpdate:update});
test('更新提示按入口原因展示，旧记录不猜来源',()=>{
 expect(planUpdateLabel({updateReason:'modify-parameters'} as WorkflowRevision)).toBe('修改执行参数');
 expect(planUpdateLabel({updateReason:'modify-plan'} as WorkflowRevision)).toBe('修改方案');
 expect(planUpdateLabel({updateReason:'save-template'} as WorkflowRevision)).toBe('保存预置方案');
 expect(planUpdateLabel({} as WorkflowRevision)).toBe('更新方案');
});
test('仅连续两条以上方案更新折叠，执行记录打断且不重排输入',()=>{
 const items=[item('1','修改方案'),item('2','修改执行参数'),item('3'),item('4','更新方案')];
 expect(groupPlanUpdates(items).map(group=>group.map(x=>x.key))).toEqual([['1','2'],['3'],['4']]);
 expect(items.map(x=>x.key)).toEqual(['1','2','3','4']);
 const html=renderToStaticMarkup(<TimelineRecords items={items}/>);
 expect(html).toContain('方案更新 · 2 条');expect(html).toContain('最近：修改执行参数');
 expect(html).not.toContain(' open=""');expect(html).toContain('data-read-identity="1"');expect(html).toContain('data-read-identity="2"');
 expect(renderToStaticMarkup(<TimelineRecords items={[item('1','修改方案')]}/>)).not.toContain('<details');
});
test('同回合两次更新之间的回复也打断分组，不跨回复合并',()=>{
 const items=[item('1','修改方案'),item('3','修改执行参数'),item('5','修改方案')];
 expect(groupPlanUpdates(items,['2']).map(group=>group.map(x=>x.key))).toEqual([['1'],['3','5']]);
 expect(groupPlanUpdates(items,['0','6']).map(group=>group.length)).toEqual([3]);
});
test('正文保持原消息容器并打断方案分组，不套记录外壳',()=>{
 const html=renderToStaticMarkup(<TimelineRecords items={[item('1','修改方案'),{key:'body',at:'2',conversationContent:true,content:<article className="chat-message assistant">原回复</article>},item('3','修改执行参数')]}/>);
 expect(html).not.toContain('<details');
 expect(html).toContain('<article class="chat-message assistant">原回复</article>');
 expect(html).not.toContain('data-read-identity="body"');
 expect(html.indexOf('data-read-identity="1"')).toBeLessThan(html.indexOf('原回复'));
 expect(html.indexOf('原回复')).toBeLessThan(html.indexOf('data-read-identity="3"'));
});
