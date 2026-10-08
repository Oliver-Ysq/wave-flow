import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "./api";
import type { AgentSnapshot, CurrentAttemptResponse, PhaseVisit, RunListItem, RunResponse, RunSnapshot } from "./types";

const terminal = new Set(["completed", "cancelled", "interrupted"]);
const filters = ["全部", "执行中", "待协助", "暂停", "已结束"] as const;
type Filter = typeof filters[number];
const localeTime = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—";

export function App() {
  const locationQuery = new URLSearchParams(window.location.search);
  const terminalRunId = locationQuery.get("terminalRunId");
  const terminalNodeId = locationQuery.get("terminalNodeId");
  if (terminalRunId && terminalNodeId) return <TerminalPage runId={terminalRunId} nodeId={terminalNodeId} />;
  const demo = import.meta.env.DEV;
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("全部");

  const refresh = useCallback(async () => {
    try {
      const next = await api.listRuns();
      setRuns(next);
      setSelectedId(current => current && next.some(run => run.runId === current) ? current : next[0]?.runId ?? null);
      setConnected(true);
      setError(null);
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selected = runs.find(run => run.runId === selectedId) ?? null;
  useEffect(() => {
    if (demo || !selected || terminal.has(selected.status)) return;
    const stream = new EventSource(`/runs/${encodeURIComponent(selected.runId)}/events`);
    const update = () => { void refresh(); setConnected(true); };
    stream.addEventListener("snapshot", update);
    stream.onerror = () => { stream.close(); setConnected(false); };
    return () => stream.close();
  }, [demo, selected?.runId, selected?.status]);

  const counters = useMemo(() => ({
    total: runs.length,
    running: runs.filter((run) => ["running", "pausing", "recovering"].includes(run.status)).length,
    blocked: runs.filter((run) => run.hasBlockedAgent).length,
    paused: runs.filter((run) => run.status === "paused").length,
  }), [runs]);
  const visibleRuns = useMemo(() => runs.filter((run) => {
    const matchQuery = run.workflow.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const matchFilter = filter === "全部"
      || filter === "执行中" && ["running", "pausing", "recovering"].includes(run.status)
      || filter === "待协助" && run.hasBlockedAgent
      || filter === "暂停" && run.status === "paused"
      || filter === "已结束" && terminal.has(run.status);
    return matchQuery && matchFilter;
  }), [runs, query, filter]);

  async function control(action: "pause" | "recover" | "stop" | "resume") {
    if (!selected) return;
    setBusy(action);
    try {
      const response = await api[action](selected.runId);
      setRuns(current => current.map(run => run.runId === response.runId ? toRunListItem(response) : run));
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">W</span><div><strong>Wave Flow</strong><span>Local orchestration console</span></div></div>
      <div className={`connection ${connected ? "online" : "offline"}`}><i />{demo ? "开发演示数据" : connected ? "Daemon connected" : "Daemon unavailable"}</div>
    </header>
    <section className="metrics" aria-label="运行概览">
      <Metric label="全部 Run" value={counters.total} tone="neutral" />
      <Metric label="执行中" value={counters.running} tone="blue" />
      <Metric label="等待协助" value={counters.blocked} tone="amber" />
      <Metric label="已暂停" value={counters.paused} tone="purple" />
    </section>
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-head"><div><span className="sidebar-kicker">我的工作流</span><strong>Runs</strong></div><button onClick={() => void refresh()} aria-label="刷新 Run 列表">↻</button></div>
        <label className="search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 Workflow 名称" /></label>
        <div className="filter-row" aria-label="按状态筛选">{filters.map(item => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div>
        <div className="list-caption">显示 {visibleRuns.length} / {runs.length} 条 Run</div>
        <div className="run-list">{visibleRuns.map(run => <RunItem key={run.runId} run={run} active={run.runId === selectedId} onClick={() => setSelectedId(run.runId)} />)}{visibleRuns.length === 0 && <div className="empty-list">没有符合条件的 Run</div>}</div>
      </aside>
      <section className="content">
        {error && <div className="notice"><span>!</span><div>{error}</div><button onClick={() => setError(null)}>×</button></div>}
        {selected ? <RunDetail run={selected} busy={busy} onControl={control} onAnswer={async (blockId, answer) => { setBusy(`answer:${blockId}`); try { await api.answer(blockId, answer); await refresh(); } finally { setBusy(null); } }} /> : <EmptyState />}
      </section>
    </div>
  </main>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{String(value).padStart(2, "0")}</strong></div>; }
function toRunListItem(response: RunResponse): RunListItem { const snapshot = response.snapshot; return { runId: response.runId, workflow: { name: snapshot.workflow.name, description: snapshot.workflow.description }, status: snapshot.status, cwd: snapshot.cwd, createdAt: snapshot.createdAt, endedAt: snapshot.endedAt, diagnostic: snapshot.diagnostic, hasBlockedAgent: snapshot.phases.some((phase) => phase.agents.some((agent) => agent.status === "blocked")) }; }
function RunItem({ run, active, onClick }: { run: RunListItem; active: boolean; onClick: () => void }) { return <button onClick={onClick} className={`run-item ${active ? "selected" : ""}`}><span className={`dot ${run.status}`} /><div><strong>{run.workflow.name}</strong><small>{run.runId.slice(0, 8)} / {localeTime(run.createdAt)}</small></div><Status status={run.status} /></button>; }

function RunDetail({ run, busy, onControl, onAnswer }: { run: RunListItem; busy: string | null; onControl: (action: "pause" | "recover" | "stop" | "resume") => Promise<void>; onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void> }) {
  const active = !run.observationOnly && ["running", "pausing", "recovering"].includes(run.status);
  const [defaultView, setDefaultView] = usePersistedView();
  const [expanded, setExpanded] = useState<AgentSnapshot | null>(null);
  const [attempt, setAttempt] = useState<CurrentAttemptResponse | null>(null);
  const [visit, setVisit] = useState<PhaseVisit | null>(null);
  const [visitLoading, setVisitLoading] = useState<number | null>(null);
  const [history, setHistory] = useState<PhaseVisit[] | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [attemptIds, setAttemptIds] = useState<number[] | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState<number | null>(null);
  useEffect(() => {
    let activeRequest = true;
    setVisit(null); setAttempt(null); setHistory(null); setHistoryCursor(null); setAttemptIds(null); setHistoryAttempt(null);
    void api.currentAttempt(run.runId).then((value) => { if (activeRequest) setAttempt(value); }).catch(() => { if (activeRequest) setAttempt(null); });
    return () => { activeRequest = false; };
  }, [run.runId, run.status]);
  useEffect(() => {
    if (!attempt) return;
    const currentVisitId = Math.max(...attempt.summary.phases.flatMap((phase) => phase.currentVisitId === null ? [] : [phase.currentVisitId]));
    if (!Number.isFinite(currentVisitId)) return;
    let activeRequest = true;
    setVisitLoading(currentVisitId);
    void api.phaseVisit(run.runId, currentVisitId).then((response) => { if (activeRequest) setVisit(response.visit); }).finally(() => { if (activeRequest) setVisitLoading(null); });
    return () => { activeRequest = false; };
  }, [attempt, run.runId]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(null); };
    window.addEventListener("keydown", close);
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", close); document.body.style.overflow = original; };
  }, [expanded]);
  return <>
    <div className="run-header"><div><div className="eyebrow">当前工作流</div><h1>{run.workflow.name}</h1><p>{run.workflow.description}</p><code>{run.runId}</code></div><div className="actions">
      {run.status === "running" && <Action label="暂停" icon="Ⅱ" tone="secondary" loading={busy === "pause"} onClick={() => void onControl("pause")} />}
      {run.status === "paused" && <Action label="恢复执行" icon="▶" tone="primary" loading={busy === "recover"} onClick={() => void onControl("recover")} />}
      {run.status === "interrupted" && <Action label="重新执行" icon="↻" tone="primary" loading={busy === "resume"} onClick={() => void onControl("resume")} />}
      {(active || (!run.observationOnly && run.status === "paused")) && <Action label="停止 Run" icon="■" tone="danger" loading={busy === "stop"} onClick={() => void onControl("stop")} />}
    </div><ViewSwitcher value={defaultView} onChange={setDefaultView} label="默认视图" /></div>
    <div className="run-meta"><Status status={run.status} /><span>创建于 {localeTime(run.createdAt)}</span><span>结束于 {localeTime(run.endedAt)}</span><span className="path">{run.cwd}</span></div>
    {run.observationOnly && <div className="observation-notice">已重新连接旧会话：可以观察、回答和继续该 Agent，但当前 daemon 未恢复 Workflow 调度。</div>}
    {run.diagnostic && <div className="diagnostic">{run.diagnostic}</div>}
    <div className="phase-list">{attempt ? <><div className="attempt-label">当前执行尝试 #{attempt.summary.executionAttemptId}</div>{attempt.summary.phases.map((phase, index) => <section className={`phase ${phase.currentVisitId !== null ? "current" : ""}`} key={phase.title}><PhaseHeader phase={phase} index={index} loading={visitLoading === (phase.currentVisitId ?? phase.latestVisitId)} onOpen={async (phaseVisitId) => { setVisitLoading(phaseVisitId); try { setVisit((await api.phaseVisit(run.runId, phaseVisitId)).visit); } finally { setVisitLoading(null); } }} />{visit?.title === phase.title && <PhaseVisitDetail visit={visit} view={defaultView} busy={busy} onAnswer={onAnswer} onOpen={setExpanded} onClose={() => setVisit(null)} />}</section>)}<section className="history-panel"><div><strong>执行记录</strong><span>{includeEmpty ? "包含没有创建 Agent 的阶段切换" : "仅显示包含 Agent 的阶段轮次"}</span></div><label><input type="checkbox" checked={includeEmpty} onChange={(event) => { setIncludeEmpty(event.target.checked); setHistory(null); setHistoryCursor(null); }} /> 显示没有 Agent 的阶段切换</label>{attemptIds && <label>执行尝试 <select value={historyAttempt ?? attempt.summary.executionAttemptId} onChange={(event) => { setHistoryAttempt(Number(event.target.value)); setHistory(null); setHistoryCursor(null); }} >{attemptIds.map((attemptId) => <option key={attemptId} value={attemptId}>{attemptId === attempt.summary.executionAttemptId ? `当前尝试 #${attemptId}` : `历史尝试 #${attemptId}`}</option>)}</select></label>}<button disabled={historyLoading} onClick={async () => { setHistoryLoading(true); try { const attempts = attemptIds ?? (await api.executionAttempts(run.runId)).executionAttemptIds; if (!attemptIds) setAttemptIds(attempts); const selectedAttempt = historyAttempt ?? attempt.summary.executionAttemptId; const page = await api.phaseVisits(run.runId, history === null ? { includeEmpty, attempt: selectedAttempt } : { cursor: historyCursor ?? undefined, includeEmpty, attempt: selectedAttempt }); setHistory(current => [...(current ?? []), ...page.items]); setHistoryCursor(page.nextCursor); } finally { setHistoryLoading(false); } }}>{history === null ? "查看执行记录" : historyLoading ? "正在加载…" : historyCursor === null ? "没有更多记录" : "加载更早记录"}</button>{history && <ol>{history.map((item) => <li key={`${item.executionAttemptId}:${item.phaseVisitId}`}><button onClick={() => setVisit(item)}>{item.title} · 第 {item.occurrence} 轮 <small>{item.batches.reduce((count, batch) => count + batch.agents.length, 0)} 名 Agent</small></button></li>)}</ol>}</section></> : <div className="empty-phase">正在读取当前执行摘要…</div>}</div>
    {expanded && <AgentDetailModal runId={run.runId} agent={expanded} busy={busy} onAnswer={onAnswer} onClose={() => setExpanded(null)} />}
  </>;
}

function PhaseHeader({ phase, index, loading, onOpen }: { phase: import("./types").PhaseSummary; index: number; loading: boolean; onOpen: (phaseVisitId: number) => void }) {
  const visitId = phase.currentVisitId ?? phase.latestVisitId;
  const state = phase.currentVisitId !== null ? "当前轮" : "最近一轮";
  return <div className="phase-title"><span>{String(index + 1).padStart(2, "0")}</span><div className="phase-heading"><div className="phase-name-row"><h2>{phase.title}</h2>{phase.currentVisitId !== null && <em>当前进行中</em>}</div><small>已进入 {phase.visits} 次 · {phase.agents} 名 Agent · {Object.entries(phase.statusCounts).filter(([, count]) => count).map(([status, count]) => `${statusLabel(status)} ${count}`).join(" · ") || "暂无 Agent"}</small></div>{visitId !== null ? <button className="phase-action" disabled={loading} onClick={() => onOpen(visitId)}>{loading ? "正在读取…" : `查看${state}`}</button> : <small className="phase-empty">尚无可查看的 Agent 轮次</small>}<i /></div>;
}

function PhaseVisitDetail({ visit, view, busy, onAnswer, onOpen, onClose }: { visit: PhaseVisit; view: ViewMode; busy: string | null; onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>; onOpen: (agent: AgentSnapshot) => void; onClose: () => void }) {
  return <section className="visit-detail"><div className="visit-title"><div><span>{visit.title} · 第 {visit.occurrence} 轮</span><small>本轮 {visit.batches.reduce((count, batch) => count + batch.agents.length, 0)} 名 Agent</small></div><button onClick={onClose}>收起本轮</button></div><div className="batch-list">{visit.batches.map((batch, index) => <ExecutionBatch key={batch.sequence} batch={batch} index={index} view={view} busy={busy} onAnswer={onAnswer} onOpen={onOpen} />)}</div></section>;
}

type ViewMode = "cards" | "tags";

function usePersistedView(): [ViewMode, (view: ViewMode) => void] {
  const storageKey = "wave-flow:agent-view:v2";
  const [view, setView] = useState<ViewMode>(() => localStorage.getItem(storageKey) === "cards" ? "cards" : "tags");
  const update = (next: ViewMode) => { localStorage.setItem(storageKey, next); setView(next); };
  return [view, update];
}

function ViewSwitcher({ value, onChange, label }: { value: ViewMode; onChange: (view: ViewMode) => void; label: string }) {
  return <div className="view-switcher" aria-label={label}><button className={value === "cards" ? "active" : ""} onClick={() => onChange("cards")}>卡片</button><button className={value === "tags" ? "active" : ""} onClick={() => onChange("tags")}>标签</button></div>;
}

function ExecutionBatch({ batch, index, view, busy, onAnswer, onOpen }: { batch: { sequence: number; mode: "serial" | "parallel"; agents: AgentSnapshot[] }; index: number; view: ViewMode; busy: string | null; onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>; onOpen: (agent: AgentSnapshot) => void }) {
  return <div className={`execution-batch ${batch.mode} ${view}`}><div className="batch-head"><span>{batch.mode === "parallel" ? `可并行执行 · ${batch.agents.length} 名 Agent` : "顺序执行"}</span>{index > 0 && <i>等待上一批完成</i>}</div>{view === "cards" ? <div className="agent-rail"><div className="agent-grid">{batch.agents.map(agent => <AgentCard key={agent.id} agent={agent} busy={busy} onAnswer={onAnswer} onOpen={() => onOpen(agent)} />)}</div></div> : <div className="agent-tags">{batch.agents.map(agent => <button key={agent.id} className={`agent-tag ${agent.status}`} onClick={() => onOpen(agent)}><span /><strong>{agent.label}</strong><small>{statusLabel(agent.status)}</small></button>)}</div>}</div>;
}

function AgentCard({ agent, busy, onAnswer, onOpen, expanded = false }: { agent: AgentSnapshot; busy: string | null; onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>; onOpen?: () => void; expanded?: boolean }) {
  const [answer, setAnswer] = useState("{}"), [answerError, setAnswerError] = useState<string | null>(null);
  const paused = ["pausing", "paused", "recovering"].includes(agent.status);
  const persona = agentPersona(agent);
  async function submit() { try { const parsed = JSON.parse(answer) as unknown; if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Answer must be a JSON object."); await onAnswer(agent.block!.blockRequestId, parsed as Record<string, unknown>); } catch (cause) { setAnswerError(cause instanceof Error ? cause.message : String(cause)); } }
  return <article className={`agent-card ${agent.status} ${expanded ? "expanded" : ""}`}><div className="agent-top"><div className={`agent-avatar ${persona.tint}`}><span>{persona.initial}</span><i /></div><div className="agent-identity"><h3>{agent.label}</h3><span className="cli-badge" title={`所用 Agent CLI：${cliLabel(agent.cli)}`}>{cliLabel(agent.cli)}</span></div><Status status={agent.status} /></div>
    <div className="agent-presence"><span className={`presence-dot ${agent.status}`} />{persona.message}</div>
    <div className="agent-context"><span>工作目录</span><code title={agent.cwd}>{shortPath(agent.cwd)}</code></div>
    {agent.diagnostic && <div className="agent-report"><span>最新汇报</span><p>{agent.diagnostic}</p></div>}
    {agent.result && <details><summary>结构化结果</summary><pre>{JSON.stringify(agent.result, null, 2)}</pre></details>}
    {agent.block && <div className="block-panel"><div className="block-label">需要你的输入</div><p>{agent.block.needHelp}</p>{paused ? <div className="paused-help">暂停中。恢复后才能交付答案。</div> : agent.block.answered ? <div className="answered-help">答案已交付，等待 Agent continue。</div> : <><textarea value={answer} onChange={event => setAnswer(event.target.value)} spellCheck={false} /><button className="submit-answer" disabled={busy === `answer:${agent.block.blockRequestId}`} onClick={() => void submit()}>{busy === `answer:${agent.block.blockRequestId}` ? "正在交付…" : "交付答案"}</button>{answerError && <span className="answer-error">{answerError}</span>}</>}</div>}
    {!expanded && onOpen && <button className="expand-agent" onClick={onOpen}>展开阅读</button>}
  </article>;
}

function AgentDetailModal({ runId, agent, busy, onAnswer, onClose }: { runId: string; agent: AgentSnapshot; busy: string | null; onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const canOpenTerminal = ["running", "blocked"].includes(agent.status);
  const openInNewTab = () => window.open(`${location.pathname}?terminalRunId=${encodeURIComponent(runId)}&terminalNodeId=${encodeURIComponent(agent.id)}`, "_blank", "noopener,noreferrer");
  return <div className="agent-modal-backdrop" role="presentation" onMouseDown={onClose}><section className={`agent-modal ${terminalOpen ? "with-terminal" : ""}`} role="dialog" aria-modal="true" aria-label={`${agent.label} 完整信息`} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span>Agent 完整信息</span><strong>{agent.label}</strong></div><div className="modal-actions">{canOpenTerminal && <><button className="terminal-toggle" onClick={() => setTerminalOpen(open => !open)}>{terminalOpen ? "收起终端" : "打开终端"}</button><button className="terminal-new-tab" onClick={openInNewTab}>新标签页打开 ↗</button></>}<button onClick={onClose} aria-label="关闭完整信息">×</button></div></div><AgentCard agent={agent} busy={busy} onAnswer={onAnswer} expanded />{terminalOpen && <WebTerminal runId={runId} agent={agent} />}</section></div>;
}

function TerminalPage({ runId, nodeId }: { runId: string; nodeId: string }) {
  const [backAvailable] = useState(() => window.opener !== null || history.length > 1);
  return <main className="terminal-page"><header className="terminal-page-head"><div className="brand"><span className="brand-mark">W</span><div><strong>Wave Flow Terminal</strong><span>独立 Agent 终端</span></div></div><div className="terminal-page-actions">{backAvailable && <button onClick={() => history.back()}>← 返回控制台</button>}<code>{nodeId}</code></div></header><section className="terminal-page-body"><WebTerminal runId={runId} agent={{ id: nodeId, label: nodeId, cli: "codex", status: "running", cwd: "", result: null, diagnostic: null, block: null }} standalone /></section></main>;
}

function WebTerminal({ runId, agent, standalone = false }: { runId: string; agent: AgentSnapshot; standalone?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("正在连接受管终端…");
  const [needsReclaim, setNeedsReclaim] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    host.current.replaceChildren();
    let socket: WebSocket | null = null, disposed = false;
    let xterm: Terminal | null = null;
    let input: { dispose(): void } | null = null;
    if (import.meta.env.DEV && runId.startsWith("demo-")) {
      xterm = new Terminal({ cols: 120, rows: 32, cursorBlink: true, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: { background: "#141924", foreground: "#dbe5f3", cursor: "#b9c7ff" } });
      xterm.open(host.current);
      xterm.write("\x1b[36mWave Flow 开发演示终端\x1b[0m\r\n\r\n这里用于检查终端布局、标签页与滚动条样式。\r\n开发演示不会连接 tmux，输入也不会发送给 Agent。\r\n\r\n› ");
      setState("开发演示 · 未连接真实 Agent");
      input = xterm.onData((data) => xterm?.write(data === "\r" ? "\r\n› " : data));
      return () => { disposed = true; input?.dispose(); xterm?.dispose(); };
    }
    void api.terminal(runId, agent.id).then((opened) => {
      if (disposed) return;
      xterm = new Terminal({ cols: opened.cols, rows: opened.rows, convertEol: false, cursorBlink: true, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: { background: "#141924", foreground: "#dbe5f3", cursor: "#b9c7ff" } });
      const fit = new FitAddon(); xterm.loadAddon(fit);
      xterm.open(host.current!);
      const terminal = xterm;
      input = terminal.onData((data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
      xterm.write(opened.initialScreen);
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${opened.wsPath}?after=${opened.outputSequence}`);
      let sentCols: number | null = null, sentRows: number | null = null;
      let resizeTimer: number | null = null;
      const resize = () => {
        fit.fit();
        // 只在浏览器窗口真正变化时同步一次。绝不监听 xterm 自己的 DOM 变化，
        // 否则 reset/reflow 又会触发 resize，形成不断重绘与滚动条抖动的循环。
        if (socket?.readyState === WebSocket.OPEN && terminal.cols >= 20 && terminal.rows >= 5 && (terminal.cols !== sentCols || terminal.rows !== sentRows)) {
          sentCols = terminal.cols; sentRows = terminal.rows;
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      };
      const requestResize = () => { if (resizeTimer !== null) window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(resize, 180); };
      socket.onopen = () => { requestAnimationFrame(resize); setState("已连接 · 可直接输入"); };
      socket.onmessage = (event) => { try { const message = JSON.parse(String(event.data)) as { type?: string; data?: string; screen?: string; cols?: number; rows?: number; reason?: string; message?: string }; if (message.type === "output" && typeof message.data === "string") terminal.write(message.data); if (message.type === "reset" && typeof message.screen === "string") { // 必须先采用 tmux 已确认的新网格，再写 capture-pane 首屏；反过来写会让超长逻辑行在旧列数上永久裁断。
          if (typeof message.cols === "number" && typeof message.rows === "number") { sentCols = message.cols; sentRows = message.rows; terminal.resize(message.cols, message.rows); }
          terminal.reset(); terminal.write(message.screen);
        } if (message.type === "closed") setState(`连接已关闭：${message.reason ?? "终端不可用"}`); if (message.type === "error") setState(message.message ?? "终端输入被拒绝"); } catch { setState("终端收到无效消息。"); } };
      socket.onclose = () => { if (!disposed) setState(current => current.startsWith("连接已关闭") ? current : "实时连接已断开"); };
      socket.onerror = () => setState("实时连接失败");
      window.addEventListener("resize", requestResize);
      const oldDispose = input.dispose.bind(input); input.dispose = () => { window.removeEventListener("resize", requestResize); if (resizeTimer !== null) window.clearTimeout(resizeTimer); oldDispose(); };
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "无法打开终端";
      setState(message);
      setNeedsReclaim(message.includes("可观察生命周期"));
    });
    return () => { disposed = true; input?.dispose(); socket?.close(); xterm?.dispose(); };
  }, [agent.id, runId, connectionAttempt]);
  async function reclaim() {
    setReclaiming(true); setState("正在验证旧 tmux 与 Codex 会话…");
    try { await api.reclaimTerminal(runId, agent.id); setNeedsReclaim(false); setConnectionAttempt(value => value + 1); }
    catch (error) { setState(error instanceof Error ? error.message : "旧会话无法重新连接"); }
    finally { setReclaiming(false); }
  }
  return <section className={`web-terminal ${standalone ? "standalone" : ""}`}><div className="web-terminal-head"><strong>Codex 终端</strong><span>{state}</span>{needsReclaim && <button className="reclaim-terminal" disabled={reclaiming} onClick={() => void reclaim()}>{reclaiming ? "正在验证…" : "重新连接旧会话"}</button>}</div><div ref={host} className="xterm-host" /></section>;
}

function Status({ status }: { status: string }) { return <span className={`status ${status}`}>{statusLabel(status)}</span>; }
function Action({ label, icon, tone, loading, onClick }: { label: string; icon: string; tone: string; loading: boolean; onClick: () => void }) { return <button className={`action ${tone}`} disabled={loading} onClick={onClick}><span>{loading ? "…" : icon}</span>{label}</button>; }
function EmptyState() { return <div className="empty-state"><div className="empty-orb">W</div><h1>还没有 Run</h1><p>从终端创建工作流后，这里会自动出现它的执行轨迹。</p><code>wave-flow run .wave-flow/workflows/example.ts</code></div>; }

function statusLabel(status: string): string {
  return ({ queued: "排队中", running: "工作中", blocked: "需要协助", pausing: "暂停中", paused: "已暂停", recovering: "恢复中", completed: "已交付", cancelled: "已停止", interrupted: "已中断" } as Record<string, string>)[status] ?? status;
}

function shortPath(path: string): string {
  const fragments = path.split("/").filter(Boolean);
  return fragments.length > 3 ? `…/${fragments.slice(-3).join("/")}` : path;
}

function agentPersona(agent: AgentSnapshot): { initial: string; message: string; tint: string } {
  const initial = agent.label.trim().slice(0, 1).toUpperCase() || "A";
  const message = ({ queued: "正在等待工作安排", running: "正在专注处理这项工作", blocked: "有一个问题需要你拍板", pausing: "正在收尾手头的动作", paused: "暂时休息，保留当前上下文", recovering: "正在回到工作状态", completed: "已经交付了本次工作", cancelled: "这项工作已被停止", interrupted: "执行被打断，等待下一步安排" } as Record<string, string>)[agent.status] ?? "正在等待状态更新";
  const tint = ["sky", "lilac", "mint", "peach"][agent.id.charCodeAt(0) % 4] ?? "sky";
  return { initial, message, tint };
}

function cliLabel(cli: AgentSnapshot["cli"]): string {
  return ({ codex: "Codex CLI" } as const)[cli];
}
