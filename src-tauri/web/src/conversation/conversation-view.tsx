import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  HarnessAvailableCommand,
  HarnessBodyEntry,
  HarnessMessageAttachment,
  HarnessQueuedMessage,
  HarnessSnapshot,
  HarnessToolActivity as HarnessToolActivitySummary,
  StagedAttachment,
} from "../types";
import { api } from "../api";
import {userFacingText} from "../user-facing-text";
import {
  composeConversationTurns,
  turnNeedsAssistantFallback,
  type ConversationTurn,
} from "./harness-event-merge";
import { Markdown } from "./markdown";
import { ThoughtBlock, ToolBlock, ToolGroupBlock } from "./entry-blocks";
import { groupToolEntries } from "./entry-groups";
import {TimelineRecords,type TimelineItem} from './plan-updates';
import { MentionComposer } from "./mention-composer";

/** 会话内有界阅读位置；不落盘正文或参数。 */
const conversationPositions = new Map<string, { top: number; stuck: boolean }>();

/** 已发送附件的 data URL 会话内缓存；附件耐久不可变，按消息身份缓存安全。 */
const attachmentDataCache = new Map<string, string>();

/** 已发送消息中的图片附件：按需从 Engine 读取耐久字节渲染缩略图。 */
function MessageAttachmentView({
  harnessRunId,
  messageId,
  attachment,
}: {
  harnessRunId: string;
  messageId: string;
  attachment: HarnessMessageAttachment;
}) {
  const key = `${harnessRunId}:${messageId}:${attachment.id}`;
  const [dataUrl, setDataUrl] = useState<string | null>(() => attachmentDataCache.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (dataUrl || failed) return;
    let active = true;
    api.attachmentData(harnessRunId, messageId, attachment.id)
      .then((response) => {
        attachmentDataCache.set(key, response.dataUrl);
        if (attachmentDataCache.size > 128) attachmentDataCache.delete(attachmentDataCache.keys().next().value!);
        if (active) setDataUrl(response.dataUrl);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [harnessRunId, messageId, attachment.id, dataUrl, failed, key]);
  return (
    <figure className="message-attachment">
      {dataUrl ? (
        <a href={dataUrl} target="_blank" rel="noreferrer" title={`${attachment.name}（新窗口查看原图）`}>
          <img src={dataUrl} alt={attachment.name} />
        </a>
      ) : (
        <span className="attachment-placeholder">{failed ? "附件读取失败" : "正在读取附件…"}</span>
      )}
      <figcaption>{attachment.name} · {formatAttachmentSize(attachment.sizeBytes)}</figcaption>
    </figure>
  );
}

/** 附件大小的人类可读格式。 */
function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/**
 * 裸 Enter 始终留给 textarea 与 IME：它可确认中文候选、切换输入状态或换行。
 * 发送只接受显式的 ⌘/Ctrl + Enter，且 composition 期间一律不拦截事件。
 */
export function shouldSubmitComposer(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.nativeEvent.isComposing &&
    !event.shiftKey
  );
}

/** 主控正文条目：Markdown 渲染；同一回合内被工具/思考打断后的后续正文续排，
 * 不重复头像与说话人，避免一次回复看起来像两条消息。 */
function BodyBlock({ entry, continuation = false }: { entry: HarnessBodyEntry; continuation?: boolean }) {
  const streaming = !entry.completed && entry.finishedAt === null;
  return (
    <article
      data-read-identity={entry.completed ? `body:${entry.entryId}` : undefined}
      className={`chat-message assistant wf-body ${streaming ? "streaming" : ""} ${continuation ? "wf-body-continuation" : ""}`}
    >
      <div className="chat-avatar" aria-hidden={continuation || undefined}>V</div>
      <div>
        {!continuation && <span>Wave Flow</span>}
        {entry.legacy ? (
          <p className="wf-entry-note">历史记录未保存</p>
        ) : (
          <Markdown text={entry.text} />
        )}
        {streaming && (
          <span className="wf-stream-cursor" aria-hidden="true">
            ▍
          </span>
        )}
        {!entry.completed && entry.finishedAt !== null && (
          <p className="wf-entry-note">未完成</p>
        )}
        {entry.truncated && <p className="wf-entry-note">记录已截断</p>}
      </div>
    </article>
  );
}

/** MCP 工具是回复的低密度尾注；只展示、也只耐久最小安全摘要（legacy 回合）。 */
function HarnessToolActivity({
  activity,
}: {
  activity: HarnessToolActivitySummary;
}) {
  const stateText = activity.outcome === "completed" ? "已完成" : "未完成";
  return (
    <details className={`harness-tool ${activity.outcome}`}>
      <summary>
        <span aria-hidden="true">⌁</span>
        {activity.label}
        <em>{stateText}</em>
      </summary>
      <p>仅保留动作名称与结果；不保存参数、路径、命令或完整输出。</p>
    </details>
  );
}

/** 单个回合：用户气泡 → 按 seq 排列的条目 → 无正文时回落渲染完整 assistant 消息。 */
function ConversationTurnView({
  turn,
  harness,
  records=[],
}: {
  /** 已组装的回合数据。 */
  turn: ConversationTurn;
  /** 当前会话快照，用于 legacy 回合的工具尾注。 */
  harness: HarnessSnapshot;
  /** 此回合发生的原更新/执行记录，按时间插入回复之间。 */
  records?:TimelineItem[];
}) {
  let bodySeen = false;
  const entries:TimelineItem[]=groupToolEntries(turn.entries).map(item=>{
    if(item.kind==='tool-group')return {key:`entry:${item.entries[0]!.entryId}`,at:item.entries[0]!.startedAt,content:<ToolGroupBlock entries={item.entries}/>};
    if(item.kind==='body'){const continuation=bodySeen;bodySeen=true;return {key:`entry:${item.entryId}`,at:item.startedAt,content:<BodyBlock entry={item} continuation={continuation}/>};}
    return {key:`entry:${item.entryId}`,at:item.startedAt,content:item.kind==='thought'?<ThoughtBlock entry={item}/>:<ToolBlock entry={item}/>};
  });
  if(turnNeedsAssistantFallback(turn)&&turn.assistant)entries.push({key:`assistant:${turn.assistant.id}`,at:turn.assistant.createdAt,content:<Fragment><article className="chat-message assistant" data-read-identity={`message:${turn.assistant.id}`}><div className="chat-avatar">V</div><div><span>Wave Flow</span><Markdown text={turn.assistant.text}/></div></article>{(harness.toolActivitiesByMessageId[turn.assistant.id]??[]).map((activity,index)=><HarnessToolActivity key={`${turn.assistant!.id}:tool:${index}`} activity={activity}/>)}</Fragment>});
  return (
    <Fragment>
      {!turn.user.summaryKey&&<article className="chat-message user">
        <div className="chat-avatar">{turn.user.summaryKey?"V":"你"}</div>
        <div>
          <span>{turn.user.summaryKey?"系统 · 执行总结":"你"}</span>
          <p>{turn.user.text}</p>
          {turn.user.attachments?.map((attachment) => (
            <MessageAttachmentView
              key={attachment.id}
              harnessRunId={harness.harnessRunId}
              messageId={turn.user.id}
              attachment={attachment}
            />
          ))}
        </div>
      </article>}
      <TimelineRecords items={[...entries.map(item=>({...item,conversationContent:true})),...records].sort((a,b)=>a.at.localeCompare(b.at))}/>
    </Fragment>
  );
}

/** 排队消息的真实状态文案；只从耐久快照推导，不用模糊 loading。 */
function queueStateLabel(
  item: HarnessQueuedMessage,
  running: boolean,
  interrupted: boolean,
  position: number,
): string {
  if (item.priority) {
    return running ? "优先 · 等待当前回合中断或结束" : "优先 · 即将投递";
  }
  if (running) return `排队中 · 第 ${position} 位`;
  return interrupted ? "排队中 · 回合已中断，发送新消息继续投递" : "排队中 · 即将投递";
}

/**
 * 对话为主的会话视图：header 动作 + 回合时间线 + 中断卡 + 输入区。
 * 草案卡/Execution/决策卡由调用方作为 children 传入，渲染在时间线之后。
 */
export function ConversationView({
  harness,
  draft,
  onDraft,
  onSend,
  onSendImmediate,
  onCancelQueued,
  onRecover,
  pendingAttachments,
  onAddAttachments,
  onRemoveAttachment,
  attachmentBusy=false,
  attachmentError,onDismissAttachmentError,
  onAbort,
  onComplete,
  onOpenWorkflow,
  hasWorkflow,
  busy,
  lastEventAt,
  children,
  timelineEvents = [],
  onRead,
  visible=true,
  draftContext,
  activity,
  planPendingBar,
  availableCommands = [],
}: {
  /** 当前 Harness 会话权威快照。 */
  harness: HarnessSnapshot;
  /** 输入框草稿文本。 */
  draft: string;
  /** 更新输入框草稿。 */
  onDraft: (text: string) => void;
  /** 发送当前草稿；忙碌时由 Engine 耐久排队。 */
  onSend: () => void;
  /** 立即发送：Engine 先中断当前回合再优先投递；未提供时不展示入口。 */
  onSendImmediate?: () => void;
  /** 取消一条尚未投递的排队消息。 */
  onCancelQueued?: (messageId: string) => void;
  /** 恢复已中断主控到待命；不重发任务、不创建新回合。 */
  onRecover?: () => void;
  /** 待发送附件（Engine 暂存描述）；未提供时不展示附件入口。 */
  pendingAttachments?: StagedAttachment[];
  /** 当前草稿正在选图/暂存；禁用重复选择并提供反馈。 */
  attachmentBusy?:boolean;
  /** 当前草稿选图错误，不随后台快照刷新消失。 */ attachmentError?:string|null;
  /** 仅关闭附件错误，不删除附件。 */ onDismissAttachmentError?:()=>void;
  /** 打开系统文件选择并暂存所选图片；选择不自动发送。 */
  onAddAttachments?: () => void;
  /** 移除一个待发送附件。 */
  onRemoveAttachment?: (stagedId: string) => void;
  /** 中断当前进行中的回合。 */
  onAbort: () => void;
  /** 归档完成会话。 */
  onComplete: () => void;
  /** 打开 Workflow 详情面板。 */
  onOpenWorkflow: () => void;
  /** 是否已有可查看的 Workflow 执行。 */
  hasWorkflow: boolean;
  /** 输入框上方的待确认方案条；由父层按最新版本与已读状态决定是否出现。 */
  planPendingBar?: ReactNode;
  /** 当前进行中的工作台动作标识；用于禁用对应 header 按钮。 */
  busy: string | null;
  /** 最近一次条目事件到达时间（Date.now() 毫秒）；无事件时为 null。 */
  lastEventAt: number | null;
  /** 时间线之后的行动点（草案卡、Execution、决策卡）。 */
  children?: ReactNode;
  /** 耐久行动点，按保存时间插入对应回合；key 绑定原版本或执行。 */
  timelineEvents?: TimelineItem[];
  /** 视口内耐久正文/原消息/版本阅读标记，不按 delta 计数。 */
  onRead?: (taskId:string,ids:string[])=>void;
  /** 隐藏页面不更新已读标记。 */
  visible?: boolean;
  /** 当前草稿绑定的方案版本提示；不修改输入内容或自动发送。 */ draftContext?:string;
  /** 当前工作与历史入口；位于滚动对话外，不改变运行权限。 */ activity?: ReactNode;
  /** 当前 ACP 会话广告的斜杠命令/技能；缺省只显示 Wave Flow 的 /wave-flow。 */
  availableCommands?: readonly HarnessAvailableCommand[];
}) {
  const attachmentButton=useRef<HTMLButtonElement>(null);
  const stopButton=useRef<HTMLButtonElement>(null);
  const running = harness.status === "running";
  const turns = composeConversationTurns(harness);
  const messageTimes=[...harness.messages.map(message=>message.createdAt),...harness.conversationEntries.filter(entry=>entry.kind==='body'&&entry.text.trim()).map(entry=>entry.startedAt)];

  const scrollRef = useRef<HTMLDivElement>(null);
  /** 贴底状态同时保存在 ref（滚动回调内读取）与 state（驱动"回到最新"按钮）。 */
  const stuckRef = useRef(true);
  const historyTop = useRef(0);
  const historySize = useRef({ width: 0, height: 0 });
  const maintainHistoryLayout = () => {
    const el = scrollRef.current;
    if (!el || !el.getClientRects().length) return;
    // 布局改变不代表用户离开底部；复用最近一次真实滚动保存的状态。
    el.scrollTop = stuckRef.current ? el.scrollHeight : historyTop.current;
    historyTop.current = el.scrollTop;
    historySize.current = { width: el.clientWidth, height: el.clientHeight };
  };
  const [stuck, setStuck] = useState(true);
  const [pendingNew, setPendingNew] = useState(false);
  useEffect(()=>{
    if(!visible||!onRead||!scrollRef.current)return;
    const root=scrollRef.current;
    const observer=new IntersectionObserver(entries=>{
      const ids=entries.filter(entry=>entry.isIntersecting).map(entry=>(entry.target as HTMLElement).dataset.readIdentity!).filter(Boolean);
      if(ids.length)onRead(harness.harnessRunId,ids);
    },{root,threshold:0.1});
    root.querySelectorAll("[data-read-identity]").forEach(element=>observer.observe(element));
    return()=>observer.disconnect();
  },[harness,visible,onRead]);
  useLayoutEffect(() => {
    const saved = conversationPositions.get(harness.harnessRunId);
    if (saved && scrollRef.current) {
      scrollRef.current.scrollTop = saved.top;
      historyTop.current = saved.top;
      stuckRef.current = saved.stuck;
      setStuck(saved.stuck);
    }
    return ()=>{
      const el=scrollRef.current;
      if(el){conversationPositions.set(harness.harnessRunId,{top:el.scrollTop,stuck:stuckRef.current});if(conversationPositions.size>64)conversationPositions.delete(conversationPositions.keys().next().value!);}
    };
  }, [harness.harnessRunId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 浏览器滚动锚定也会发 scroll；尺寸改变期间不能覆盖布局前的贴底意图。
    if (el.clientWidth !== historySize.current.width || el.clientHeight !== historySize.current.height) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    historyTop.current = el.scrollTop;
    stuckRef.current = near;
    setStuck(near);
    conversationPositions.delete(harness.harnessRunId);
    conversationPositions.set(harness.harnessRunId, { top: el.scrollTop, stuck: near });
    if (conversationPositions.size > 64) conversationPositions.delete(conversationPositions.keys().next().value!);
    if (near) setPendingNew(false);
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stuckRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setPendingNew(true);
    }
  }, [harness]);

  // running 期间每秒重渲染一次，仅用于"等待新的输出"计时展示，不推断模型状态。
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  /** 停止是破坏性动作：先确认，避免误点中断当前回合。 */
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => { if (!running) setConfirmStop(false); }, [running]);
  const waitingBase = lastEventAt ?? Date.parse(harness.createdAt);
  const waitingSeconds = Number.isFinite(waitingBase) ? Math.max(0, Math.floor((Date.now() - waitingBase) / 1_000)) : 0;
  const streamingBody = harness.conversationEntries.some(entry => entry.kind === "body" && !entry.completed && entry.finishedAt === null);
  const waiting = running && !streamingBody && Number.isFinite(waitingBase) && Date.now() - waitingBase > 3_000;
  // 一次安静等待只在"开始出现新正文"或回合结束时收起；工具进展不应该让提示反复闪烁。
  const [waitingVisible, setWaitingVisible] = useState(false);
  useEffect(() => {
    if (!running || streamingBody) { setWaitingVisible(false); return; }
    if (waiting) setWaitingVisible(true);
  }, [running, streamingBody, waiting]);

  return (
    <div
      className="conversation"
    >
      <header>
        <div>
          <span className={`task-presence ${harness.status}`} />
          <div>
            <strong>{conversationTitle(harness)}</strong>
            <small title={harness.cwd}>{harness.cwd.split("/").filter(Boolean).at(-1)}</small>
          </div>
        </div>
      </header>
      {activity}
      <div className="conversation-scroll" ref={scrollRef} onScroll={handleScroll}>
        {harness.messages.length === 0 && (
          <div className="conversation-intro">
            <span>Wave Flow 已就绪</span>
            <h2>你想完成什么任务？</h2>
            <p>
              先告诉我目标和约束。后续 Workflow
              启动后，会作为行动点出现在这条对话中。
            </p>
          </div>
        )}
        {turns.map((turn, index) => (
          <Fragment key={turn.turnId}>
          <TimelineRecords items={timelineEvents.filter(event=>event.beforeTurnId===turn.turnId)} messageTimes={messageTimes} />
          <ConversationTurnView
            key={turn.turnId}
            turn={turn}
            harness={harness}
            records={timelineEvents.filter(event => !event.beforeTurnId&&event.at >= turn.user.createdAt && (!turns[index + 1] || event.at < turns[index + 1].user.createdAt))}
          />
          </Fragment>
        ))}
        {harness.diagnostic?.includes("主控启动失败") && (
          <article className="conversation-interruption" role="alert">
            <strong>Wave Flow 暂时无法启动</strong>
            <p>{userFacingText(harness.diagnostic)}</p>
          </article>
        )}
        {waitingVisible && (
          <div className="wf-waiting" role="status">
            仍在处理
            {waitingSeconds >= 60 ? ` · 已等待 ${formatWaitTime(waitingSeconds)}` : ""}
          </div>
        )}
        {children}
      </div>
      {!stuck && pendingNew && (
        <button
          type="button"
          className="wf-back-to-latest"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            stuckRef.current = true;
            setStuck(true);
            setPendingNew(false);
          }}
        >
          回到最新
        </button>
      )}
      {harness.status !== "completed" && planPendingBar}
      {harness.status !== "completed" && (
        <div className="conversation-composer">
          {harness.messageQueue.length > 0 && (
            <ul className="message-queue" aria-label="待发送消息队列">
              {harness.messageQueue.map((item, index) => (
                <li key={item.message.id} className={item.priority ? "priority" : ""}>
                  <span className="queue-state">
                    {queueStateLabel(item, running, harness.status === "interrupted", index + 1)}
                  </span>
                  <span className="queue-text">{item.message.text}</span>
                  {onCancelQueued && (
                    <button
                      type="button"
                      className="queue-cancel"
                      aria-label="取消这条排队消息"
                      onClick={() => onCancelQueued(item.message.id)}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {draftContext&&<p className="composer-context" role="status">{draftContext}</p>}
          {attachmentError&&<div className="attachment-error" role="alert"><span>{attachmentError}</span><button type="button" aria-label="关闭附件错误" onClick={()=>{onDismissAttachmentError?.();requestAnimationFrame(()=>attachmentButton.current?.focus());}}>×</button></div>}
          {pendingAttachments && pendingAttachments.length > 0 && (
            <ul className="pending-attachments" aria-label="待发送附件">
              {pendingAttachments.map((attachment) => (
                <li key={attachment.stagedId}>
                  {attachment.previewDataUrl ? (
                    <img src={attachment.previewDataUrl} alt={attachment.name} />
                  ) : (
                    <span className="attachment-kind" aria-hidden="true">图</span>
                  )}
                  <span className="attachment-meta">
                    <strong>{attachment.name}</strong>
                    <small>{attachment.mimeType.replace("image/", "").toUpperCase()} · {formatAttachmentSize(attachment.sizeBytes)} · 待发送</small>
                  </span>
                  {onRemoveAttachment && (
                    <button
                      type="button"
                      className="queue-cancel"
                      aria-label={`移除附件 ${attachment.name}`}
                      onClick={() => onRemoveAttachment(attachment.stagedId)}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <MentionComposer
            onLayout={maintainHistoryLayout}
            value={draft}
            ariaLabel="补充要求或反馈"
            onChange={onDraft}
            placeholder={running ? "可以补充要求 · 消息将排队发送" : harness.status === "interrupted" ? "回合已中断 · 发送消息继续" : "补充要求，或反馈执行结果…"}
            commands={availableCommands}
            onSubmit={() => {
              if (draft.trim() && !attachmentBusy) onSend();
            }}
            onSubmitImmediate={onSendImmediate ? () => {
              if (draft.trim()) onSendImmediate();
            } : undefined}
          />
          <div className="composer-footer">
            <div className="composer-guidance">
              {onAddAttachments ? (
                <button
                  ref={attachmentButton}
                  type="button"
                  className="add-attachment"
                  aria-label="添加图片附件"
                  title="添加图片附件（最多5张，选择后不会自动发送）"
                  disabled={attachmentBusy}
                  aria-busy={attachmentBusy}
                  onClick={onAddAttachments}
                >
                  ＋
                </button>
              ) : (
                <span aria-hidden="true">＋</span>
              )}
              {attachmentBusy&&<small role="status">正在添加图片…</small>}
              {harness.status === "interrupted" ? (
                <small role="status">
                  回合已中断 · 发送消息继续
                  {onRecover && (
                    <>
                      {" · "}
                      <button type="button" className="recover-quiet" onClick={onRecover}>
                        仅恢复待命
                      </button>
                    </>
                  )}
                </small>
              ) : (
                <small>
                  {running
                    ? "⌘/Ctrl + Enter 排队发送 · Ctrl + S 立即发送"
                    : "⌘/Ctrl + Enter 发送 · Enter 换行"}
                </small>
              )}
            </div>
            <div className="composer-actions">
              {running && onSendImmediate && (
                <button
                  type="button"
                  className="send-immediate"
                  disabled={!draft.trim()||attachmentBusy}
                  onClick={onSendImmediate}
                >
                  立即发送
                </button>
              )}
              {running ? (
                <>
                  <button
                    className="send-message"
                    aria-label="排队发送"
                    title="加入队列"
                    disabled={!draft.trim()||attachmentBusy}
                    onClick={onSend}
                  >
                    ↑
                  </button>
                  {confirmStop ? (
                    <span
                      className="stop-confirm"
                      role="alertdialog"
                      aria-label="确认停止当前回合"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setConfirmStop(false);
                        }
                      }}
                    >
                      <span>停止后本轮未完成内容会中断，已完成内容保留。</span>
                      <button type="button" autoFocus onClick={() => {
                        setConfirmStop(false);
                        requestAnimationFrame(() => stopButton.current?.focus());
                      }}>
                        继续等待
                      </button>
                      <button type="button" className="danger" onClick={() => {
                        setConfirmStop(false);
                        onAbort();
                        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")?.focus());
                      }}>
                        确认停止
                      </button>
                    </span>
                  ) : (
                    <button ref={stopButton} className="stop-turn" onClick={() => setConfirmStop(true)}>
                      停止
                    </button>
                  )}
                </>
              ) : (
                <button
                  className="send-message"
                  aria-label="发送消息"
                  disabled={!draft.trim()||attachmentBusy}
                  onClick={onSend}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 长等待只展示已用时间，不替用户判断是否卡住。 */
function formatWaitTime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 会话标题：第一条用户消息前 28 字，退化为目录名。 */
function conversationTitle(harness: HarnessSnapshot): string {
  return (
    harness.task?.title || harness.messages
      .find((message) => message.role === "user")
      ?.text.slice(0, 28) ||
    harness.cwd.split("/").filter(Boolean).at(-1) ||
    "新任务"
  );
}
