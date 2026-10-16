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
  HarnessBodyEntry,
  HarnessSnapshot,
  HarnessToolActivity as HarnessToolActivitySummary,
} from "../types";
import {
  composeConversationTurns,
  turnNeedsAssistantFallback,
  type ConversationTurn,
} from "./harness-event-merge";
import { Markdown } from "./markdown";
import { ThoughtBlock, ToolBlock, ToolGroupBlock } from "./entry-blocks";
import { groupToolEntries } from "./entry-groups";

/** 会话内有界阅读位置；不落盘正文或参数。 */
const conversationPositions = new Map<string, { top: number; stuck: boolean }>();

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

/** 主控正文条目：Markdown 渲染；流式中显示闪烁光标，中断残留与截断显式标注。 */
function BodyBlock({ entry }: { entry: HarnessBodyEntry }) {
  const streaming = !entry.completed && entry.finishedAt === null;
  return (
    <article
      data-read-identity={entry.completed ? `body:${entry.entryId}` : undefined}
      className={`chat-message assistant wf-body ${streaming ? "streaming" : ""}`}
    >
      <div className="chat-avatar">W</div>
      <div>
        <span>主控 Agent</span>
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
}: {
  /** 已组装的回合数据。 */
  turn: ConversationTurn;
  /** 当前会话快照，用于 legacy 回合的工具尾注。 */
  harness: HarnessSnapshot;
}) {
  return (
    <Fragment>
      {!turn.user.summaryKey&&<article className="chat-message user">
        <div className="chat-avatar">{turn.user.summaryKey?"W":"你"}</div>
        <div>
          <span>{turn.user.summaryKey?"系统 · 影响面总结":"你"}</span>
          <p>{turn.user.text}</p>
        </div>
      </article>}
      {groupToolEntries(turn.entries).map((item) => {
        if (item.kind === "tool-group") {
          return (
            <ToolGroupBlock key={item.entries[0].entryId} entries={item.entries} />
          );
        }
        if (item.kind === "body")
          return <BodyBlock key={item.entryId} entry={item} />;
        if (item.kind === "thought")
          return <ThoughtBlock key={item.entryId} entry={item} />;
        return <ToolBlock key={item.entryId} entry={item} />;
      })}
      {turnNeedsAssistantFallback(turn) && turn.assistant && (
        <Fragment>
          <article className="chat-message assistant" data-read-identity={`message:${turn.assistant.id}`}>
            <div className="chat-avatar">W</div>
            <div>
              <span>主控 Agent</span>
              <Markdown text={turn.assistant.text} />
            </div>
          </article>
          {(harness.toolActivitiesByMessageId[turn.assistant.id] ?? []).map(
            (activity, index) => (
              <HarnessToolActivity
                key={`${turn.assistant!.id}:tool:${index}`}
                activity={activity}
              />
            ),
          )}
        </Fragment>
      )}
    </Fragment>
  );
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
}: {
  /** 当前 Harness 会话权威快照。 */
  harness: HarnessSnapshot;
  /** 输入框草稿文本。 */
  draft: string;
  /** 更新输入框草稿。 */
  onDraft: (text: string) => void;
  /** 发送当前草稿。 */
  onSend: () => void;
  /** 中断当前进行中的回合。 */
  onAbort: () => void;
  /** 归档完成会话。 */
  onComplete: () => void;
  /** 打开 Workflow 详情面板。 */
  onOpenWorkflow: () => void;
  /** 是否已有可查看的 Workflow 执行。 */
  hasWorkflow: boolean;
  /** 当前进行中的工作台动作标识；用于禁用对应 header 按钮。 */
  busy: string | null;
  /** 最近一次条目事件到达时间（Date.now() 毫秒）；无事件时为 null。 */
  lastEventAt: number | null;
  /** 时间线之后的行动点（草案卡、Execution、决策卡）。 */
  children?: ReactNode;
  /** 耐久行动点，按保存时间插入对应回合；key 绑定原版本或执行。 */
  timelineEvents?: Array<{ key: string; at: string; content: ReactNode; /** 绑定总结回合，结果卡在正文前与首片段一起呈现。 */ beforeTurnId?:string }>;
  /** 视口内耐久正文/原消息/版本阅读标记，不按 delta 计数。 */
  onRead?: (taskId:string,ids:string[])=>void;
  /** 隐藏页面不更新已读标记。 */
  visible?: boolean;
  /** 当前草稿绑定的方案版本提示；不修改输入内容或自动发送。 */ draftContext?:string;
}) {
  const running = harness.status === "running";
  const turns = composeConversationTurns(harness);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** 贴底状态同时保存在 ref（滚动回调内读取）与 state（驱动"回到最新"按钮）。 */
  const stuckRef = useRef(true);
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
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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
  const waitingBase = lastEventAt ?? Date.parse(harness.createdAt);
  const waiting =
    running && Number.isFinite(waitingBase) && Date.now() - waitingBase > 3_000;

  return (
    <div className="conversation">
      <header>
        <div>
          <span className={`task-presence ${harness.status}`} />
          <div>
            <strong>{conversationTitle(harness)}</strong>
            <small>{harness.cwd}</small>
          </div>
        </div>
        <div className="conversation-actions">
          {harness.status !== "completed" && (
            <>
              <button
                disabled={
                  busy === "complete-harness" ||
                  running ||
                  harness.executions.some((item) => item.finishedAt === null)
                }
                onClick={onComplete}
                data-archive-task={harness.harnessRunId}
              >
                {busy === "complete-harness" ? "正在归档…" : "归档任务"}
              </button>
            </>
          )}
          <button disabled={!hasWorkflow} onClick={onOpenWorkflow}>
            查看 Workflow
          </button>
        </div>
      </header>
      <div className="conversation-scroll" ref={scrollRef} onScroll={handleScroll}>
        {harness.messages.length === 0 && (
          <div className="conversation-intro">
            <span>主控已就绪</span>
            <h2>你想完成什么任务？</h2>
            <p>
              先告诉我目标和约束。后续 Workflow
              启动后，会作为行动点出现在这条对话中。
            </p>
          </div>
        )}
        {turns.map((turn, index) => (
          <Fragment key={turn.turnId}>
          {timelineEvents.filter(event=>event.beforeTurnId===turn.turnId).map(event=><div className="workflow-timeline-item" data-read-identity={event.key} key={event.key}>{event.content}</div>)}
          <ConversationTurnView
            key={turn.turnId}
            turn={turn}
            harness={harness}
          />
          {timelineEvents.filter(event => !event.beforeTurnId&&event.at >= turn.user.createdAt && (!turns[index + 1] || event.at < turns[index + 1].user.createdAt)).sort((a,b)=>a.at.localeCompare(b.at)).map(event => <div className="workflow-timeline-item" data-read-identity={event.key} key={event.key}>{event.content}</div>)}
          </Fragment>
        ))}
        {(harness.status === "interrupted" || harness.diagnostic?.includes("主控启动失败")) && (
          <article className="conversation-interruption" role="alert">
            <strong>{harness.diagnostic?.includes("主控启动失败")?"主控暂时无法启动":"主控回合已中断"}</strong>
            <p>{harness.diagnostic || "本回合未能产生完整回答。"}</p>
            <small>可直接发送下一条消息重试；不会自动重发或执行 Workflow。</small>
          </article>
        )}
        {waiting && <div className="wf-waiting">等待新的输出</div>}
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
      {harness.status !== "completed" && (
        <div className="conversation-composer">
          {draftContext&&<p className="composer-context" role="status">{draftContext}</p>}
          <textarea
            value={draft}
            disabled={running}
            onChange={(event) => onDraft(event.target.value)}
            placeholder={running ? "主控正在处理当前消息" : "给主控发送消息"}
            onKeyDown={(event) => {
              if (shouldSubmitComposer(event)) {
                event.preventDefault();
                if (draft.trim() && !running) onSend();
              }
            }}
          />
          <div className="composer-footer">
            <div className="composer-guidance">
              <span aria-hidden="true">＋</span>
              <small>⌘/Ctrl + Enter 发送 · Enter 换行</small>
            </div>
            {running ? (
              <button className="stop-turn" onClick={onAbort}>
                停止
              </button>
            ) : (
              <button
                className="send-message"
                aria-label="发送消息"
                disabled={!draft.trim()}
                onClick={onSend}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
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
