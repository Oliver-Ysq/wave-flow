import {test,expect} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {PreviousRecords} from '../../src-tauri/web/src/execution/previous-records';
test('正常结果不展示运行编号，多次恢复只提供折叠的时间记录',()=>{
 const one=renderToStaticMarkup(<PreviousRecords current={1} onSelect={()=>{}} records={[]}/>);
 expect(one).toBe('');
 const many=renderToStaticMarkup(<PreviousRecords current={3} selected={3} onSelect={()=>{}} records={[{id:1,at:'2026-10-18T01:00:00Z',status:'cancelled'},{id:2,status:'interrupted'}]}/>);
 expect(many).toContain('恢复前的记录');expect(many).toContain('已停止');expect(many).toContain('时间未保存');
 expect(many).not.toContain('attempt');expect(many).not.toContain('执行尝试');expect(many).not.toContain('<select');expect(many).not.toContain('查看最新记录');
 const old=renderToStaticMarkup(<PreviousRecords current={3} selected={1} onSelect={()=>{}} records={[]}/>);
 expect(old).toContain('这是恢复前保存的记录');expect(old).toContain('查看最新记录');
 const notice=renderToStaticMarkup(<PreviousRecords part="notice" current={3} selected={1} onSelect={()=>{}} records={[]}/>);
 expect(notice).not.toContain('<details');
 const list=renderToStaticMarkup(<PreviousRecords part="list" current={3} selected={1} onSelect={()=>{}} records={[]}/>);
 expect(list).not.toContain('这是恢复前保存的记录');
});
test('执行与结果共用原终态时间，聊天事件不展示恢复次数',async()=>{
 const app=await Bun.file('src-tauri/web/src/App.tsx').text();
 const events=await Bun.file('src-tauri/web/src/conversation/workflow-summary.tsx').text();
 expect(app).toContain('records={previousRecords}');
 expect(app).toContain('item.kind === "finished"');
 expect(app).not.toContain('<label>执行尝试');
 expect(events).not.toContain('第 {attempt} 次');
 const result=app.slice(app.indexOf('function HistoricalResults('),app.indexOf('function ImpactSummaryNotice('));
 expect(result.indexOf('part="list"')).toBeGreaterThan(result.indexOf('高级 / 诊断信息'));
 const execution=app.slice(app.indexOf('function ExecutionDetail('),app.indexOf('function GateCard('));
 expect(execution.indexOf('part="list"')).toBeGreaterThan(execution.indexOf('<TeamPanel'));
});
