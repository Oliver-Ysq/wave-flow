import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AssistantRuntimeProvider, ChainOfThoughtPrimitive, useLocalRuntime } from "@assistant-ui/react";
import { api } from "./api";
import type { AgentSnapshot, CliRuntime, CliRuntimeListResponse, CurrentAttemptResponse, ExecutionResponse, HarnessDecision, HarnessProject, HarnessSnapshot, PhaseVisit, RunListItem, RunResponse, RunSnapshot, WorkflowExecution } from "./types";

const terminal = new Set(["completed", "cancelled", "interrupted"]);
const localeTime = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—";
type ColorTheme = "dark" | "light";
const themeStorageKey = "wave-flow:color-theme:v1";
function readColorTheme(): ColorTheme { return localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark"; }
function terminalColors(theme: ColorTheme) { return theme === "light" ? { background: "#f8f9fd", foreground: "#25314a", cursor: "#665ce2", selectionBackground: "#d9ddff" } : { background: "#11141d", foreground: "#d8e0f0", cursor: "#aeb8ff", selectionBackground: "#404875" }; }

export function App() {
  const locationQuery = new URLSearchParams(window.location.search);
  const terminalRunId = locationQuery.get("terminalRunId");
  const terminalNodeId = locationQuery.get("terminalNodeId");
  if (terminalRunId && terminalNodeId) return <TerminalPage runId={terminalRunId} nodeId={terminalNodeId} />;
  const demo = import.meta.env.DEV;
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessSnapshot[]>([]);
  const [projects, setProjects] = useState<HarnessProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [harness, setHarness] = useState<HarnessSnapshot | null>(null);
  /** 新会话仅是浏览器草稿；首次发送前没有 Harness id、目录或 Journal。 */
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const [projectCwd, setProjectCwd] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [streamAnswer, setStreamAnswer] = useState("");
  const [harnessStreamReady, setHarnessStreamReady] = useState(false);
  const [harnessText, setHarnessText] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftingRevision, setDraftingRevision] = useState(false);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [executionDetail, setExecutionDetail] = useState<ExecutionResponse | null>(null);
  const [theme, setTheme] = useState<ColorTheme>(readColorTheme);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(themeStorageKey, theme); window.dispatchEvent(new CustomEvent<ColorTheme>("wave-flow:theme", { detail: theme })); }, [theme]);

  const refresh = useCallback(async () => {
    try {
      const [next, harnessList, projectList] = await Promise.all([api.listRuns(), api.listHarnesses(), api.projects()]);
      setRuns(next);
      setHarnesses(harnessList.harnesses);
      setProjects(projectList.projects);
      setSelectedProjectId(current => current && projectList.projects.some(project => project.projectId === current) ? current : projectList.projects[0]?.projectId ?? null);
      setSelectedId(current => current && next.some(run => run.runId === current) ? current : null);
      // 当前 running Harness 的权威增量来自它自己的 SSE。列表轮询可能在
      // user_message/turn_started 已耐久、但 assistant 尚未完成时返回旧快照；
      // 若覆盖当前状态会让流式 thinking/answer 与消息列表发生回滚。
      setHarness(current => {
        if (!current || current.status === "running") return current;
        return harnessList.harnesses.find(item => item.harnessRunId === current.harnessRunId) ?? current;
      });
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
    if (!harness?.harnessRunId) return;
    setHarnessStreamReady(false);
    const stream = new EventSource(`/harness-runs/${encodeURIComponent(harness.harnessRunId)}/events`);
    stream.addEventListener("reasoning_delta", (event) => { const value = JSON.parse((event as MessageEvent).data) as { delta: string }; setReasoning(current => current + value.delta); });
    stream.addEventListener("assistant_delta", (event) => { const value = JSON.parse((event as MessageEvent).data) as { delta: string }; setStreamAnswer(current => current + value.delta); });
    stream.addEventListener("snapshot", () => setHarnessStreamReady(true));
    const refreshHarness = () => { void api.harness(harness.harnessRunId).then((response) => { setHarness(response.harness); setStreamAnswer(""); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); };
    stream.addEventListener("turn_finished", refreshHarness);
    stream.addEventListener("turn_interrupted", () => { setStreamAnswer(""); refreshHarness(); });
    stream.addEventListener("execution_changed", refreshHarness);
    stream.onerror = () => setHarnessStreamReady(false);
    return () => stream.close();
  }, [harness?.harnessRunId]);
  useEffect(() => {
    if (demo || !selected || terminal.has(selected.status)) return;
    const stream = new EventSource(`/runs/${encodeURIComponent(selected.runId)}/events`);
    const update = () => { void refresh(); setConnected(true); };
    stream.addEventListener("snapshot", update);
    stream.onerror = () => { stream.close(); setConnected(false); };
    return () => stream.close();
  }, [demo, selected?.runId, selected?.status]);

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

  async function createRun(value: { workflowPath: string; cwd: string; input: Record<string, unknown> }) {
    setBusy("create");
    try {
      const response = await api.createRun({ ...value, clientRequestId: crypto.randomUUID() });
      const item = toRunListItem(response);
      setRuns(current => [item, ...current.filter(run => run.runId !== item.runId)]);
      setSelectedId(response.runId);
      setCreating(false);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

  async function createProject() { try { const response = await api.createProject(projectCwd, projectTitle); setProjects(current => [response.project, ...current.filter(project => project.projectId !== response.project.projectId)]); setSelectedProjectId(response.project.projectId); setProjectCwd(""); setProjectTitle(""); setCreatingProject(false); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  function beginHarnessDraft(projectId = selectedProjectId) { if (!projectId) return; setSelectedProjectId(projectId); setDraftProjectId(projectId); setHarness(null); setHarnessText(""); setReasoning(""); setStreamAnswer(""); setWorkflowPanelOpen(false); setError(null); }
  async function sendHarness() {
    if (!harnessText.trim()) return;
    try {
      setReasoning(""); setStreamAnswer("");
      if (harness) {
        if (!harnessStreamReady) return;
        await api.sendHarnessMessage(harness.harnessRunId, harnessText);
        setHarnessText(""); setHarness(await api.harness(harness.harnessRunId).then((response) => response.harness));
      } else if (draftProjectId) {
        const response = await api.startHarnessConversation(draftProjectId, harnessText);
        setHarness(response.harness); setHarnesses(current => [response.harness, ...current]); setHarnessText(""); setDraftProjectId(null);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const selectExecution = useCallback(async (executionId: string) => {
    if (!harness) return;
    try { const detail = await api.execution(harness.harnessRunId, executionId); setSelectedExecutionId(executionId); setExecutionDetail(detail); setWorkflowPanelOpen(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [harness]);
  useEffect(() => {
    if (!harness || !selectedExecutionId) return;
    let active = true;
    const reload = () => { void api.execution(harness.harnessRunId, selectedExecutionId).then(value => { if (active) setExecutionDetail(value); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }); };
    reload();
    const stream = new EventSource(`/harness-runs/${encodeURIComponent(harness.harnessRunId)}/executions/${encodeURIComponent(selectedExecutionId)}/events`);
    stream.addEventListener("snapshot", reload);
    stream.onerror = () => stream.close();
    return () => { active = false; stream.close(); };
  }, [harness?.harnessRunId, selectedExecutionId]);
  async function createExecution(revision: number) {
    if (!harness) return;
    setBusy(`create-execution:${revision}`);
    try { const detail = await api.createExecution(harness.harnessRunId, revision); setExecutionDetail(detail); setSelectedExecutionId(detail.execution.executionId); setWorkflowPanelOpen(true); setHarness((await api.harness(harness.harnessRunId)).harness); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }
  async function controlExecution(action: "pause" | "recover" | "stop" | "resume") {
    if (!harness || !executionDetail) return;
    setBusy(`execution:${action}`);
    try { const detail = action === "resume" ? await api.resumeExecution(harness.harnessRunId, executionDetail.execution.executionId) : await api.executionControl(harness.harnessRunId, executionDetail.execution.executionId, action); setExecutionDetail(detail); setHarness((await api.harness(harness.harnessRunId)).harness); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

  return <main className={`agent-workbench theme-${theme} ${workflowPanelOpen ? "workflow-open" : ""}`}>
    <aside className="task-rail">
      <header><div className="brand"><span className="brand-mark">W</span><div><strong>Wave Flow</strong><span>本地主控工作台</span></div></div><div className="rail-actions"><button className="theme-toggle" onClick={() => setTheme(current => current === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"} title={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}>{theme === "dark" ? "☀" : "☾"}</button><button className="settings-button" onClick={() => setSettingsOpen(true)} aria-label="主控与执行底座设置">⚙</button><div className={`connection ${connected ? "online" : "offline"}`} title={connected ? "Daemon connected" : "Daemon unavailable"}><i /></div></div></header>
      <button className="new-task" onClick={() => { if (selectedProjectId) beginHarnessDraft(); else { setCreatingProject(true); setProjectCwd(""); setProjectTitle(""); } }}>⊕ {selectedProjectId ? "新建会话" : "新建项目"}</button>
      <div className="task-section-title"><span>项目</span><button onClick={() => void refresh()} aria-label="刷新项目与会话">↻</button></div>
      <nav className="task-list">{projects.map(project => <ProjectGroup key={project.projectId} project={project} selected={selectedProjectId === project.projectId} harnesses={harnesses.filter(item => item.projectId === project.projectId)} activeHarnessId={harness?.harnessRunId ?? null} onSelectProject={() => { setSelectedProjectId(project.projectId); setHarness(null); setDraftProjectId(null); }} onNewSession={() => beginHarnessDraft(project.projectId)} onSelectHarness={item => { setSelectedProjectId(project.projectId); setHarness(item); setDraftProjectId(null); setReasoning(""); setStreamAnswer(""); }} />)}{harnesses.some(item => item.projectId === null) && <div className="legacy-project"><span>未归类历史会话</span>{harnesses.filter(item => item.projectId === null).map(item => <HarnessListItem key={item.harnessRunId} item={item} active={harness?.harnessRunId === item.harnessRunId} onClick={() => { setHarness(item); setDraftProjectId(null); setReasoning(""); setStreamAnswer(""); }} />)}</div>}{projects.length === 0 && <p>还没有项目，请从侧边栏创建。</p>}</nav>
      <footer><span>本机运行</span><small>{demo ? "开发数据" : connected ? "daemon 已连接" : "daemon 未连接"}</small></footer>
    </aside>
    <section className="conversation-pane">
      {error && <div className="toast-layer" role="status" aria-live="polite"><div className="notice"><span>!</span><div>{error}</div><button aria-label="关闭错误提示" onClick={() => setError(null)}>×</button></div></div>}
      {!harness ? draftProjectId ? <DraftConversation project={projects.find(project => project.projectId === draftProjectId) ?? null} text={harnessText} onText={setHarnessText} onSend={() => void sendHarness()} /> : <ProjectWelcome project={projects.find(project => project.projectId === selectedProjectId) ?? null} onNewSession={() => beginHarnessDraft()} /> : <HarnessConversation harness={harness} reasoning={reasoning} streamAnswer={streamAnswer} streamReady={harnessStreamReady} text={harnessText} onText={setHarnessText} onSend={() => void sendHarness()} onAbort={() => void api.abortHarness(harness.harnessRunId)} onOpenWorkflow={() => setWorkflowPanelOpen(true)} hasWorkflow={harness.executions.length > 0} onDraft={() => setDraftingRevision(true)} onAccept={async (revision) => { try { const response = await api.acceptWorkflowRevision(harness.harnessRunId, revision); setHarness(response.harness); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} onCreateExecution={(revision) => void createExecution(revision)} onSelectExecution={(executionId) => void selectExecution(executionId)} onAnswerDecision={async (decisionId, answer) => { setBusy(`decision:${decisionId}`); try { const response = await api.answerHarnessDecision(harness.harnessRunId, decisionId, answer); setHarness(response.harness); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); } }} busy={busy} />}
    </section>
    <aside className={`workflow-pane ${workflowPanelOpen ? "open" : "closed"}`}>
      <header><div><span>{executionDetail ? `Execution · revision v${executionDetail.execution.revision}` : "Workflow 运行详情"}</span><strong>{executionDetail?.snapshot.workflow.name ?? selected?.workflow.name ?? "尚未选择"}</strong></div><button onClick={() => setWorkflowPanelOpen(false)} aria-label="隐藏 Workflow 详情">×</button></header>
      {executionDetail && harness ? <div className="workflow-detail-scroll"><ExecutionDetail detail={executionDetail} busy={busy} onControl={controlExecution} onAnswer={async (gateId, answer) => { setBusy(`gate:${gateId}`); try { const next = await api.answerExecutionGate(harness.harnessRunId, executionDetail.execution.executionId, gateId, answer); setExecutionDetail(next); } finally { setBusy(null); } }} /></div> : !selected ? <div className="workflow-empty"><div>◇</div><strong>等待主控发起 Workflow</strong><p>已接受的草案会在对话中显示“创建执行”；Execution 启动后这里展示 revision、attempt、Phase、Agent 与决策门。</p>{runs.length > 0 && <><span>当前独立运行记录</span><div className="workflow-run-picker">{runs.map(run => <button key={run.runId} onClick={() => setSelectedId(run.runId)}><i className={`dot ${run.status}`} /><div><strong>{run.workflow.name}</strong><small>{localeTime(run.createdAt)}</small></div></button>)}</div></>}</div> : <div className="workflow-detail-scroll"><RunDetail run={selected} busy={busy} onControl={control} onAnswer={async (blockId, answer) => { setBusy(`answer:${blockId}`); try { await api.answer(blockId, answer); await refresh(); } finally { setBusy(null); } }} /></div>}
      <button className="legacy-workflow" onClick={() => setCreating(true)}>从本地 workflow 启动</button>
    </aside>
    {!workflowPanelOpen && <button className="workflow-peek" onClick={() => setWorkflowPanelOpen(true)}><span>Workflow</span><b>{runs.filter(run => !terminal.has(run.status)).length}</b></button>}
    {creating && <CreateRunModal busy={busy === "create"} onCreate={createRun} onClose={() => setCreating(false)} />}
    {creatingProject && <ProjectCreateModal cwd={projectCwd} title={projectTitle} onCwd={setProjectCwd} onTitle={setProjectTitle} onClose={() => setCreatingProject(false)} onCreate={() => void createProject()} />}
    {settingsOpen && <HarnessSettings onClose={() => setSettingsOpen(false)} onError={setError} />}
    {draftingRevision && harness && <WorkflowDraftModal onClose={() => setDraftingRevision(false)} onPropose={async (source) => { try { const response = await api.proposeWorkflowRevision(harness.harnessRunId, source); setHarness(response.harness); setDraftingRevision(false); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} />}
  </main>;
}

function HarnessSettings({ onClose, onError }: { onClose: () => void; onError: (value: string) => void }) {
  const [runtimeState, setRuntimeState] = useState<CliRuntimeListResponse | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const reloadRuntimes = useCallback(async () => { setRuntimeState(await api.cliRuntimes()); }, []);
  useEffect(() => { void reloadRuntimes().catch(cause => onError(cause instanceof Error ? cause.message : String(cause))); }, [reloadRuntimes, onError]);
  async function scan() { setRuntimeBusy(true); try { const result = await api.discoverCliRuntimes(); if (result.candidates[0]) setManualPath(result.candidates[0].executablePath); else onError("未在本机 PATH 中发现可执行的 Codex CLI。可手动填写绝对路径。 "); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } finally { setRuntimeBusy(false); } }
  async function validate() { if (!manualPath.trim()) return; setRuntimeBusy(true); try { await api.validateCliRuntime(manualPath.trim()); await reloadRuntimes(); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } finally { setRuntimeBusy(false); } }
  async function selectRuntime(runtime: CliRuntime) { setRuntimeBusy(true); try { await api.selectCliRuntime(runtime.runtimeId); await reloadRuntimes(); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } finally { setRuntimeBusy(false); } }
  const selected = runtimeState?.runtimes.find(runtime => runtimeState.selectedByCli.codex === runtime.runtimeId) ?? null;
  return <div className="settings-backdrop connection-backdrop" onMouseDown={onClose}><section className="connection-panel runtime-settings" aria-label="主控与执行底座" onMouseDown={event => event.stopPropagation()}><header className="connection-panel-head"><div><span className="modal-kicker">本机连接</span><strong>主控与执行底座</strong><p>一个已验证的 CLI 同时服务主控与 Worker，但始终使用独立会话。</p></div><button className="modal-close" type="button" onClick={onClose} aria-label="关闭设置">×</button></header><section className="runtime-status" aria-live="polite">{selected ? <><div className="status-mark verified">✓</div><div><span>当前默认 Runtime</span><strong>{selected.cli === "codex" ? "Codex CLI" : selected.cli}</strong><code title={selected.executablePath}>{selected.executablePath}</code><small>{selected.version} · ACP adapter {selected.verifiedAdapter.adapterVersion}</small></div><em>已验证</em></> : <><div className="status-mark">◇</div><div><span>尚未连接 Runtime</span><strong>先选择一个本机 CLI</strong><small>首条主控消息与真实 Worker 都会在创建前安全拒绝。</small></div></>}</section><section className="connection-form"><div className="section-row"><div><strong>添加或重新验证</strong><span>扫描只读取 PATH 候选，不会发送业务任务。</span></div><button className="button-secondary" disabled={runtimeBusy} onClick={() => void scan()}>{runtimeBusy ? "正在扫描…" : "扫描本机 CLI"}</button></div><label className="connection-field"><span>CLI 绝对路径</span><input value={manualPath} onChange={event => setManualPath(event.target.value)} placeholder="/Users/you/.local/bin/codex" spellCheck={false} /></label><button className="button-primary full-width" disabled={runtimeBusy || !manualPath.trim()} onClick={() => void validate()}>{runtimeBusy ? "正在验证连接…" : "验证 CLI"}</button></section>{runtimeState?.runtimes.length ? <section className="runtime-list"><span className="list-caption">已验证 Runtime</span>{runtimeState.runtimes.map(runtime => <article key={runtime.runtimeId} className={runtimeState.selectedByCli.codex === runtime.runtimeId ? "selected" : ""}><div><strong>{runtime.cli === "codex" ? "Codex CLI" : runtime.cli}</strong><code title={runtime.executablePath}>{runtime.executablePath}</code><small>{runtime.version} · adapter {runtime.verifiedAdapter.adapterVersion}</small>{runtime.diagnostic && <p>{runtime.diagnostic}</p>}</div><button className={runtimeState.selectedByCli.codex === runtime.runtimeId ? "button-state" : "button-secondary"} disabled={runtimeBusy || runtime.status !== "verified" || runtimeState.selectedByCli.codex === runtime.runtimeId} onClick={() => void selectRuntime(runtime)}>{runtimeState.selectedByCli.codex === runtime.runtimeId ? "当前默认" : "设为默认"}</button></article>)}</section> : null}</section></div>;
}

function HarnessListItem({ item, active, onClick }: { item: HarnessSnapshot; active: boolean; onClick: () => void }) { return <button className={`harness-list-item ${active ? "active" : ""}`} onClick={onClick}><span className={`task-presence ${item.status}`} /><div><strong>{conversationTitle(item)}</strong><small>{item.status === "running" ? "进行中" : item.status === "interrupted" ? "已中断" : "待命"} · {localeTime(item.createdAt)}</small></div></button>; }
function ProjectGroup({ project, selected, harnesses, activeHarnessId, onSelectProject, onNewSession, onSelectHarness }: { project: HarnessProject; selected: boolean; harnesses: HarnessSnapshot[]; activeHarnessId: string | null; onSelectProject: () => void; onNewSession: () => void; onSelectHarness: (harness: HarnessSnapshot) => void }) { return <section className={`project-group ${selected ? "selected" : ""}`}><header><button onClick={onSelectProject}><span className="folder-glyph" aria-hidden="true">⌑</span><strong>{project.title}</strong></button><button className="project-new-session" onClick={onNewSession} aria-label={`在 ${project.title} 新建会话`}>＋</button></header>{harnesses.length > 0 ? <div className="project-conversations">{harnesses.map(item => <HarnessListItem key={item.harnessRunId} item={item} active={item.harnessRunId === activeHarnessId} onClick={() => onSelectHarness(item)} />)}</div> : <button className="project-empty" onClick={onNewSession}>在此项目开启首个会话</button>}</section>; }
function ProjectWelcome({ project, onNewSession }: { project: HarnessProject | null; onNewSession: () => void }) { return <div className="new-conversation"><div className="welcome-orbit"><div className="new-conversation-mark">W</div></div><span className="welcome-kicker">{project ? "项目已就绪" : "本地工作区"}</span><h1>{project ? project.title : "先选择一个项目"}</h1><p>{project ? "项目路径已在本机安全验证。接下来可以在同一上下文中持续创建和切换主控会话。" : "从左侧新建或选择项目。项目决定后续会话的工作目录，会话区不再选择路径。"}</p>{project && <><code className="welcome-path">{project.cwd}</code><button onClick={onNewSession}>创建第一条会话 <span>↗</span></button></>}</div>; }
function ProjectCreateModal({ cwd, title, onCwd, onTitle, onClose, onCreate }: { cwd: string; title: string; onCwd: (value: string) => void; onTitle: (value: string) => void; onClose: () => void; onCreate: () => void }) { return <div className="settings-backdrop connection-backdrop" onMouseDown={onClose}><section className="connection-panel project-create" aria-label="添加本地项目" onMouseDown={event => event.stopPropagation()}><header className="connection-panel-head"><div><span className="modal-kicker">侧边栏项目</span><strong>添加本地项目</strong><p>项目路径只在这里登记。之后可在同一项目下持续创建主控会话。</p></div><button className="modal-close" onClick={onClose} aria-label="关闭创建项目">×</button></header><section className="connection-form project-fields"><label className="connection-field"><span>项目路径</span><input value={cwd} onChange={event => onCwd(event.target.value)} placeholder="/绝对路径/项目目录" autoFocus /></label><label className="connection-field"><span>显示名称 <i>可选</i></span><input value={title} onChange={event => onTitle(event.target.value)} placeholder="默认使用目录名" /></label></section><footer className="modal-actions"><button className="button-secondary" onClick={onClose}>取消</button><button className="button-primary" disabled={!cwd.trim()} onClick={onCreate}>创建项目</button></footer></section></div>; }

/** 仅由浏览器维护的新会话草稿；首次发送前不会创建 Harness、目录或 Journal。 */
function DraftConversation({ project, text, onText, onSend }: { project: HarnessProject | null; text: string; onText: (value: string) => void; onSend: () => void }) {
  const ready = project !== null;
  return <div className="conversation draft-conversation"><header><div><span className="task-presence" /><div><strong>新对话</strong><small>{project?.title ?? "未选择项目"}</small></div></div><div className="conversation-actions"><span>发送后创建会话</span></div></header><div className="conversation-scroll"><div className="conversation-intro"><span>新对话</span><h2>你想完成什么任务？</h2><p>先告诉我目标和约束。发送第一条消息后，这条会话才会保存到当前项目。</p></div></div><div className="conversation-composer"><textarea autoFocus value={text} disabled={!ready} onChange={event => onText(event.target.value)} placeholder={ready ? "给主控发送消息" : "请先选择项目"} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (text.trim() && ready) onSend(); } }} /><div><small>Enter 发送 · Shift + Enter 换行 · 未发送内容不会创建会话</small><button className="send-message" disabled={!ready || !text.trim()} onClick={onSend}>发送 ↑</button></div></div></div>;
}

function HarnessConversation({ harness, reasoning, streamAnswer, streamReady, text, onText, onSend, onAbort, onOpenWorkflow, hasWorkflow, onDraft, onAccept, onCreateExecution, onSelectExecution, onAnswerDecision, busy }: { harness: HarnessSnapshot; reasoning: string; streamAnswer: string; streamReady: boolean; text: string; onText: (value: string) => void; onSend: () => void; onAbort: () => void; onOpenWorkflow: () => void; hasWorkflow: boolean; onDraft: () => void; onAccept: (revision: number) => void; onCreateExecution: (revision: number) => void; onSelectExecution: (executionId: string) => void; onAnswerDecision: (decisionId: string, answer: Record<string, unknown>) => Promise<void>; busy: string | null }) {
  const running = harness?.status === "running";
  return <div className="conversation"><header><div><span className={`task-presence ${harness.status}`} /><div><strong>{conversationTitle(harness)}</strong><small>{harness.cwd}</small></div></div><div className="conversation-actions"><button onClick={onDraft}>提议 Workflow</button><button disabled={!hasWorkflow} onClick={onOpenWorkflow}>查看 Workflow</button></div></header><div className="conversation-scroll">{harness.messages.length === 0 && <div className="conversation-intro"><span>主控已就绪</span><h2>你想完成什么任务？</h2><p>先告诉我目标和约束。后续 Workflow 启动后，会作为行动点出现在这条对话中。</p></div>}{harness.messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><div className="chat-avatar">{message.role === "user" ? "你" : "W"}</div><div><span>{message.role === "user" ? "你" : "主控 Agent"}</span><p>{message.text}</p></div></article>)}{harness.workflowRevisions.map(revision => <article className="workflow-action" key={revision.revision}><span>Workflow 草案 v{revision.revision}</span><code>{revision.sourceHash.slice(0, 12)}</code><p>{revision.acceptedAt ? "已接受并冻结；可由用户显式创建 Execution。" : "待确认；不会创建 Run 或 Worker。"}</p>{!revision.acceptedAt ? <button onClick={() => onAccept(revision.revision)}>接受并冻结</button> : <button disabled={busy === `create-execution:${revision.revision}` || harness.executions.some(item => item.finishedAt === null)} onClick={() => onCreateExecution(revision.revision)}>{busy === `create-execution:${revision.revision}` ? "正在创建执行…" : harness.executions.some(item => item.finishedAt === null) ? "等待当前执行结束" : "创建执行"}</button>}<details><summary>查看 workflow.ts</summary><pre>{revision.source}</pre></details></article>)}{harness.executions.map(execution => <ExecutionAction key={execution.executionId} execution={execution} onSelect={() => onSelectExecution(execution.executionId)} />)}{harness.decisions.filter(decision => decision.answer === null).map(decision => <HarnessDecisionCard key={decision.decisionId} decision={decision} busy={busy === `decision:${decision.decisionId}`} onAnswer={async answer => onAnswerDecision(decision.decisionId, answer)} />)}{reasoning && <HarnessReasoning reasoning={reasoning} />}{streamAnswer && <article className="chat-message assistant streaming"><div className="chat-avatar">W</div><div><span>主控 Agent · 正在生成</span><p>{streamAnswer}</p></div></article>}{running && !reasoning && !streamAnswer && <div className="harness-thinking">主控正在响应…</div>}</div><div className="conversation-composer"><textarea value={text} disabled={running || !streamReady} onChange={event => onText(event.target.value)} placeholder={running ? "主控正在处理当前消息" : !streamReady ? "正在连接主控流…" : "给主控发送消息"} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (text.trim() && streamReady && !running) onSend(); } }} /><div><small>Enter 发送 · Shift + Enter 换行 · 思考过程不会保存</small>{running ? <button className="stop-turn" onClick={onAbort}>停止</button> : <button className="send-message" disabled={!text.trim() || !streamReady} onClick={onSend}>发送 ↑</button>}</div></div></div>;
}

function ExecutionAction({ execution, onSelect }: { execution: WorkflowExecution; onSelect: () => void }) { return <article className="workflow-action execution-action"><span>Execution · revision v{execution.revision}</span><code>{execution.executionId.slice(0, 12)} · attempt 由详情 Journal 记录</code><p><Status status={execution.status} /> {execution.finishedAt ? `结束于 ${localeTime(execution.finishedAt)}` : "正在或等待执行"}</p>{execution.diagnostic && <p className="diagnostic">{execution.diagnostic}</p>}<button onClick={onSelect}>查看执行详情</button></article>; }

function HarnessDecisionCard({ decision, busy, onAnswer }: { decision: HarnessDecision; busy: boolean; onAnswer: (answer: Record<string, unknown>) => Promise<void> }) { const [text, setText] = useState("{}"); const [error, setError] = useState<string | null>(null); async function submit() { try { const answer = JSON.parse(text) as unknown; if (!answer || Array.isArray(answer) || typeof answer !== "object") throw new Error("答案必须是 JSON 对象。 "); setError(null); await onAnswer(answer as Record<string, unknown>); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } } return <article className="workflow-action harness-decision"><span>主控需要你的决定</span><p>{decision.question}</p>{decision.answerSchema && <details><summary>查看答案 Schema</summary><pre>{JSON.stringify(decision.answerSchema, null, 2)}</pre></details>}<textarea value={text} onChange={event => setText(event.target.value)} spellCheck={false} /><button disabled={busy} onClick={() => void submit()}>{busy ? "正在交付…" : "提交决定"}</button>{error && <p className="answer-error">{error}</p>}</article>; }

function ExecutionDetail({ detail, busy, onControl, onAnswer }: { detail: ExecutionResponse; busy: string | null; onControl: (action: "pause" | "recover" | "stop" | "resume") => Promise<void>; onAnswer: (gateId: string, answer: Record<string, unknown>) => Promise<void> }) { return <><div className="execution-summary"><span>冻结 revision v{detail.execution.revision}</span><code>{detail.execution.sourceHash}</code><small>Runtime v{detail.execution.runtimeVersion} · 当前 attempt #{detail.snapshot.currentExecutionAttemptId}</small></div><div className="actions">{detail.snapshot.status === "running" && <Action label="暂停" icon="Ⅱ" tone="secondary" loading={busy === "execution:pause"} onClick={() => void onControl("pause")} />}{detail.snapshot.status === "paused" && <Action label="恢复执行" icon="▶" tone="primary" loading={busy === "execution:recover"} onClick={() => void onControl("recover")} />}{detail.snapshot.status === "interrupted" && <Action label="重新执行" icon="↻" tone="primary" loading={busy === "execution:resume"} onClick={() => void onControl("resume")} />}{["running", "pausing", "recovering", "paused"].includes(detail.snapshot.status) && <Action label="停止 Execution" icon="■" tone="danger" loading={busy === "execution:stop"} onClick={() => void onControl("stop")} />}</div>{detail.snapshot.diagnostic && <div className="diagnostic">{detail.snapshot.diagnostic}</div>}{detail.snapshot.gates.filter(gate => gate.answer === null).map(gate => <GateCard key={gate.gateId} gate={gate} busy={busy === `gate:${gate.gateId}`} onAnswer={answer => onAnswer(gate.gateId, answer)} />)}<ExecutionSnapshotDetail snapshot={detail.snapshot} /></>; }

function ExecutionSnapshotDetail({ snapshot }: { snapshot: RunSnapshot }) { return <div className="execution-phases">{snapshot.phases.map(phase => <section className="phase" key={phase.title}><div className="phase-title"><div className="phase-heading"><h2>{phase.title}</h2><small>{phase.agents.length} 名 Agent · {phase.batches.length} 个调度批次</small></div></div>{phase.batches.map(batch => <div className={`execution-batch ${batch.mode}`} key={batch.sequence}><div className="batch-head"><span>{batch.mode === "parallel" ? "并行批次" : "顺序批次"} #{batch.sequence}</span></div><div className="agent-grid">{batch.agents.map(agent => <article className="agent-card" key={agent.id}><div className="agent-presence"><Status status={agent.status} /><strong>{agent.label}</strong></div><code>{agent.id} · {agent.cli}</code>{agent.diagnostic && <p className="diagnostic">{agent.diagnostic}</p>}{agent.result && <pre>{JSON.stringify(agent.result, null, 2)}</pre>}</article>)}</div></div>)}</section>)}</div>; }

function GateCard({ gate, busy, onAnswer }: { gate: RunSnapshot["gates"][number]; busy: boolean; onAnswer: (answer: Record<string, unknown>) => Promise<void> }) { const [text, setText] = useState("{}"); const [error, setError] = useState<string | null>(null); async function submit() { try { const answer = JSON.parse(text) as unknown; if (!answer || Array.isArray(answer) || typeof answer !== "object") throw new Error("答案必须是 JSON 对象。 "); setError(null); await onAnswer(answer as Record<string, unknown>); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } } return <article className="workflow-action execution-gate"><span>Execution 决策门 · {gate.gateId}</span><p>{gate.question}</p>{gate.answerSchema && <details><summary>查看答案 Schema</summary><pre>{JSON.stringify(gate.answerSchema, null, 2)}</pre></details>}<textarea value={text} onChange={event => setText(event.target.value)} spellCheck={false} /><button disabled={busy} onClick={() => void submit()}>{busy ? "正在交付…" : "提交答案"}</button>{error && <p className="answer-error">{error}</p>}</article>; }

function WorkflowDraftModal({ onClose, onPropose }: { onClose: () => void; onPropose: (source: string) => void }) { const [source, setSource] = useState("const meta = { name: \"draft-workflow\", description: \"待确认的 Workflow 草案\", phases: [{ title: \"计划\" }] };\n\nasync function run(args) {\n  phase(\"计划\");\n  return agent(\"请完成已确认的任务\", { id: \"plan\", cli: \"codex\" });\n}"); return <div className="settings-backdrop" onMouseDown={onClose}><section className="workflow-draft" onMouseDown={event => event.stopPropagation()}><header><div><span>Workflow 提案</span><strong>冻结前的草案</strong></div><button onClick={onClose}>×</button></header><p>保存后只产生不可变 hash 草案；接受动作也不会创建 Worker 或执行代码。创建 Execution 前请使用受限语法：顶层仅 const meta 与 async function run(args)，不得 export/import 或访问 Bun/Node。</p><textarea value={source} onChange={event => setSource(event.target.value)} spellCheck={false} /><div><button onClick={onClose}>取消</button><button className="primary" onClick={() => onPropose(source)}>保存草案</button></div></section></div>; }

/** assistant-ui 只管理瞬时 thinking accordion；对话事实仍以 daemon Journal 为权威。 */
function HarnessReasoning({ reasoning }: { reasoning: string }) {
  const runtime = useLocalRuntime({ run: async () => ({ content: [] }) });
  return <AssistantRuntimeProvider runtime={runtime}><ChainOfThoughtPrimitive.Root className="harness-reasoning"><ChainOfThoughtPrimitive.AccordionTrigger>主控正在思考 · 仅当前流可见</ChainOfThoughtPrimitive.AccordionTrigger><pre>{reasoning}</pre></ChainOfThoughtPrimitive.Root></AssistantRuntimeProvider>;
}

function conversationTitle(harness: HarnessSnapshot): string { return harness.messages.find(message => message.role === "user")?.text.slice(0, 28) || harness.cwd.split("/").filter(Boolean).at(-1) || "新任务"; }

function CreateRunModal({ busy, onCreate, onClose }: { busy: boolean; onCreate: (value: { workflowPath: string; cwd: string; input: Record<string, unknown> }) => Promise<void>; onClose: () => void }) {
  const [workflowPath, setWorkflowPath] = useState("");
  const [cwd, setCwd] = useState("");
  const [input, setInput] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("输入必须是 JSON 对象。 ");
      if (!workflowPath.trim() || !cwd.trim()) throw new Error("请填写 workflow 路径和项目目录。 ");
      setError(null);
      await onCreate({ workflowPath: workflowPath.trim(), cwd: cwd.trim(), input: parsed as Record<string, unknown> });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="create-backdrop" role="presentation" onMouseDown={onClose}><form className="create-run" aria-label="新建 Run" onSubmit={event => void submit(event)} onMouseDown={event => event.stopPropagation()}>
    <div className="create-head"><div><span>新建任务</span><strong>从本地 workflow 启动</strong></div><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
    <label>Workflow 路径<input value={workflowPath} onChange={event => setWorkflowPath(event.target.value)} placeholder="/绝对路径/flow.ts 或项目内相对路径" autoFocus /></label>
    <label>项目目录 cwd<input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="/绝对路径/项目目录" /></label>
    <label>输入 JSON<textarea value={input} onChange={event => setInput(event.target.value)} spellCheck={false} /></label>
    {error && <div className="create-error">{error}</div>}
    <div className="create-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy} type="submit">{busy ? "正在创建…" : "创建 Run"}</button></div>
  </form></div>;
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
  const [theme, setTheme] = useState<ColorTheme>(readColorTheme);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(themeStorageKey, theme); window.dispatchEvent(new CustomEvent<ColorTheme>("wave-flow:theme", { detail: theme })); }, [theme]);
  return <main className={`terminal-page theme-${theme}`}><header className="terminal-page-head"><div className="brand"><span className="brand-mark">W</span><div><strong>Wave Flow Terminal</strong><span>独立 Agent 终端</span></div></div><div className="terminal-page-actions"><button className="theme-toggle" onClick={() => setTheme(current => current === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}>{theme === "dark" ? "☀" : "☾"}</button>{backAvailable && <button onClick={() => history.back()}>← 返回控制台</button>}<code>{nodeId}</code></div></header><section className="terminal-page-body"><WebTerminal runId={runId} agent={{ id: nodeId, label: nodeId, cli: "codex", status: "running", cwd: "", result: null, diagnostic: null, block: null }} standalone theme={theme} /></section></main>;
}

function WebTerminal({ runId, agent, standalone = false, theme = readColorTheme() }: { runId: string; agent: AgentSnapshot; standalone?: boolean; theme?: ColorTheme }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("正在连接受管终端…");
  const [needsReclaim, setNeedsReclaim] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [terminalTheme, setTerminalTheme] = useState<ColorTheme>(theme);
  useEffect(() => { setTerminalTheme(theme); }, [theme]);
  useEffect(() => { const update = (event: Event) => setTerminalTheme((event as CustomEvent<ColorTheme>).detail); window.addEventListener("wave-flow:theme", update); return () => window.removeEventListener("wave-flow:theme", update); }, []);
  useEffect(() => {
    if (!host.current) return;
    host.current.replaceChildren();
    let socket: WebSocket | null = null, disposed = false;
    let xterm: Terminal | null = null;
    let input: { dispose(): void } | null = null;
    if (import.meta.env.DEV && runId.startsWith("demo-")) {
      xterm = new Terminal({ cols: 120, rows: 32, cursorBlink: true, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: terminalColors(terminalTheme) });
      xterm.open(host.current);
      xterm.write("\x1b[36mWave Flow 开发演示终端\x1b[0m\r\n\r\n这里用于检查终端布局、标签页与滚动条样式。\r\n开发演示不会连接 tmux，输入也不会发送给 Agent。\r\n\r\n› ");
      setState("开发演示 · 未连接真实 Agent");
      input = xterm.onData((data) => xterm?.write(data === "\r" ? "\r\n› " : data));
      return () => { disposed = true; input?.dispose(); xterm?.dispose(); };
    }
    void api.terminal(runId, agent.id).then((opened) => {
      if (disposed) return;
      xterm = new Terminal({ cols: opened.cols, rows: opened.rows, convertEol: false, cursorBlink: true, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: terminalColors(terminalTheme) });
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
  }, [agent.id, runId, connectionAttempt, terminalTheme]);
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
