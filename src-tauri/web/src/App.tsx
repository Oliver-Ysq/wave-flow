import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { ConversationView, shouldSubmitComposer as conversationShouldSubmitComposer } from "./conversation/conversation-view";
import { WorkflowRevisionCard } from "./conversation/revision-card";
import { WorkflowProposalSummary, WorkflowExecutionSummary } from "./conversation/workflow-summary";
import { workflowCells, editableRevision, type WorkbenchRoute } from "./workbench-navigation";
import { routeMatchesTask, newerTaskSnapshot, OperationTracker, RequestFence, UnreadTracker } from "./workbench-state";
import { ViewCache } from "./workbench-state";
const taskExpansions=new ViewCache<boolean>();
const detailPositions=new ViewCache<number>();
const resultAttempts=new ViewCache<number>();
import { TeamPanel } from "./execution/team-panel";
import { ExecutionProgressCard } from "./execution/progress-card";
import { SchemaForm } from "./forms/schema-form";
import {TemplatePicker} from "./template-picker";
import {PersistedDetails} from "./persisted-details";
import {
  acceptEnvelope,
  applyHarnessEventToSnapshot,
  createStreamTracker,
} from "./conversation/harness-event-merge";
import type {
  CliRuntime,
  CliRuntimeListResponse,
  CurrentAttemptResponse,
  DesktopStatusResponse,
  ExecutionResponse,
  HarnessDecision,
  HarnessProject,
  HarnessSnapshot,
  PhaseVisit,
  RunListItem,
  RunResponse,
  RunSnapshot,
  WorkflowExecution,
} from "./types";

const terminal = new Set(["completed", "cancelled", "interrupted"]);
const localeTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value))
    : "—";
type ColorTheme = "dark" | "light";
const themeStorageKey = "wave-flow:color-theme:v1";
function readColorTheme(): ColorTheme {
  return localStorage.getItem(themeStorageKey) === "light" ? "light" : "dark";
}
/** 浏览器入口没有桌面窗口；只在 Tauri 容器中同步 macOS 原生标题栏明暗外观。 */
function syncNativeWindowTheme(theme: ColorTheme) {
  if (!("__TAURI_INTERNALS__" in window)) return;
  void invoke("set_window_theme", { theme }).catch(() => {});
}


export function App() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessSnapshot[]>([]);
  const [projects, setProjects] = useState<HarnessProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyOperations,setBusyOperations]=useState<Record<string,string>>({});
  const operationTracker=useRef(new OperationTracker());
  const beginBusy=(owner:string,action:string)=>{
    const release=operationTracker.current.begin(owner,action);
    setBusyOperations(current=>({...current,[owner]:action}));
    return ()=>{if(!release())return;setBusyOperations(current=>{const next={...current};delete next[owner];return next;});};
  };
  const [harness, setHarness] = useState<HarnessSnapshot | null>(null);
  /** 新会话仅是浏览器草稿；首次发送前没有 Harness id、目录或 Journal。 */
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [route, setRoute] = useState<WorkbenchRoute>({ kind: "conversation" });
  const [navOpen, setNavOpen] = useState(false);
  const navigationButton=useRef<HTMLButtonElement|null>(null);
  const navigationPanel=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    if(!navOpen)return;
    navigationPanel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();setNavOpen(false);navigationButton.current?.focus();}
      if(event.key==="Tab"&&window.matchMedia("(max-width:900px)").matches){
        const controls=[...navigationPanel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')??[]].filter(element=>element.getClientRects().length>0);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    window.addEventListener("keydown",keydown);
    return()=>window.removeEventListener("keydown",keydown);
  },[navOpen]);
  const [search, setSearch] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [templatePicker,setTemplatePicker]=useState(false);
  const createRequest = useRef<string | null>(null);
  const sending = useRef(false);
  const routeRef = useRef(route); routeRef.current = route;
  const harnessRef = useRef(harness); harnessRef.current = harness;
  const detailToken = useRef(0);
  const requestFence=useRef(new RequestFence());
  const unreadTracker=useRef(new UnreadTracker());
  const [,refreshRead]=useState(0);
  const markRead=useCallback((owner:string,ids:string[])=>{const task=harnessRef.current;if(!task||task.harnessRunId!==owner||routeRef.current.kind!=="conversation")return;unreadTracker.current.mark(owner,ids);refreshRead(value=>value+1);},[]);
  const unreadCounts=new Map(harnesses.map(task=>[task.harnessRunId,unreadTracker.current.count(harness?.harnessRunId===task.harnessRunId?newerTaskSnapshot(task,harness):task,false)]));
  const navigationToken = useRef(0);
  const workflowLocations = useRef(new Map<string, WorkbenchRoute>());
  const previousTask = useRef<string | null>(null);
  useEffect(() => {
    navigationToken.current += 1;
    const currentTask = harness?.harnessRunId ?? null;
    if (previousTask.current !== currentTask) {
      workflowLocations.current.clear();
      previousTask.current = currentTask;
    }
    if (route.kind !== "workflow") return;
    const key = `${route.taskId}:${route.cardId}`;
    workflowLocations.current.delete(key);
    workflowLocations.current.set(key, route);
    if (workflowLocations.current.size > 64) workflowLocations.current.delete(workflowLocations.current.keys().next().value!);
  }, [route, harness?.harnessRunId, draftProjectId]);
  const workflowPanelOpen = route.kind === "workflow" || selectedId !== null;
  const centralScroll=useRef<HTMLElement|null>(null);
  const pageKey=route.kind==="workflow"?`${route.taskId}:${route.cardId}:${route.revision}:${route.section}:${route.executionId??""}:${route.attempt??"current"}`:"conversation";
  useEffect(()=>{
    const el=centralScroll.current;if(!el||route.kind!=="workflow")return;
    el.scrollTop=detailPositions.get(pageKey)??0;
    return()=>{detailPositions.set(pageKey,el.scrollTop);};
  },[pageKey]);
  function setWorkflowPanelOpen(open: boolean) { if (!open) setRoute({ kind: "conversation" }); }
  function openWorkflow(task: HarnessSnapshot, revision: import("./types").WorkflowRevision, section?: "plan" | "execution" | "results", executionId?: string) {
    setTemplatePicker(false);
    setHarness(task); setSelectedId(null); setDraftProjectId(null);
    const cardId = revision.cardId ?? `legacy:${revision.revision}`;
    const saved = harnessRef.current?.harnessRunId === task.harnessRunId ? workflowLocations.current.get(`${task.harnessRunId}:${cardId}`) : undefined;
    const linked = task.executions.find(item => item.revision === revision.revision);
    const next: WorkbenchRoute = !section && saved?.kind === "workflow" && task.workflowRevisions.some(item => item.revision === saved.revision)
      ? saved : { kind: "workflow", taskId: task.harnessRunId, cardId, revision: revision.revision, section: section ?? (linked ? "execution" : "plan"), executionId: executionId ?? linked?.executionId };
    setRoute(next);
    setNavOpen(false);
    setSelectedExecutionId(next.executionId ?? null); setExecutionDetail(null);
  }
  const [projectCwd, setProjectCwd] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [harnessText, setHarnessText] = useState("");
  /** 最近一次 Harness 条目事件到达时间；切换会话或重读快照时重置。 */
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  /** 输入框草稿按会话/项目缓存；每次击键即写入，切换时按键恢复。 */
  const draftCacheRef = useRef(new Map<string, string>());
  const draftKey =
    harness?.harnessRunId ??
    `draft:${draftProjectId ?? selectedProjectId ?? "none"}`;
  const updateHarnessText = useCallback(
    (value: string) => {
      draftCacheRef.current.set(draftKey, value);
      if (draftCacheRef.current.size > 64) draftCacheRef.current.delete(draftCacheRef.current.keys().next().value!);
      setHarnessText(value);
    },
    [draftKey],
  );
  useEffect(() => {
    setHarnessText(draftCacheRef.current.get(draftKey) ?? "");
  }, [draftKey]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Runtime 列表只来自 Engine；页面不能把发现结果当作已验证或默认选择。 */
  const [runtimeState, setRuntimeState] =
    useState<CliRuntimeListResponse | null>(null);
  const [runtimeScanning, setRuntimeScanning] = useState(false);
  const runtimeScanStarted = useRef(false);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    null,
  );
  const [executionDetail, setExecutionDetail] =
    useState<ExecutionResponse | null>(null);
  /** 当前详情 revision 的动态节点数；plan 不可用或为 0 时按 0 处理。 */
  const [executionDynamicCount, setExecutionDynamicCount] = useState(0);
  useEffect(() => {
    if (!harness || !executionDetail) return;
    setExecutionDynamicCount(executionDetail.dynamicCount??0);
  }, [harness?.harnessRunId, executionDetail?.execution.revision]);
  /** 分配卡当前服务的已接受 revision；非 null 时展示两卡横滑流程。 */
  const [theme, setTheme] = useState<ColorTheme>(readColorTheme);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [harnessView, setHarnessView] = useState<"active" | "completed">("active");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
    syncNativeWindowTheme(theme);
    window.dispatchEvent(
      new CustomEvent<ColorTheme>("wave-flow:theme", { detail: theme }),
    );
  }, [theme]);

  /** 菜单栏意图由窄 invoke 轮询消费；拒绝 event plugin 权限时也不能中断整个工作台。 */
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      try { const action = await invoke<string | null>("take_menu_action"); if (active) { if (action === "shutdown") setExitConfirmOpen(true); else if (action === "settings") setSettingsOpen(true); } }
      catch { /* 菜单栏是辅助 UI；轮询失败绝不改变工作台或 Engine 状态。 */ }
      finally { if (active) timer = window.setTimeout(() => void poll(), 500); }
    };
    void poll();
    return () => { active = false; if (timer !== null) window.clearTimeout(timer); };
  }, []);

  const refresh = useCallback(async () => {
    const valid=requestFence.current.begin("task-list");
    try {
      const [next, harnessList, projectList, runtimes] = await Promise.all([
        api.listRuns(),
        api.listHarnesses(),
        api.projects(),
        api.cliRuntimes(),
      ]);
      if(!valid())return;
      setRuns(next);
      setHarnesses(current=>harnessList.harnesses.map(next=>{const old=current.find(item=>item.harnessRunId===next.harnessRunId);return old?newerTaskSnapshot(old,next):next;}));
      setProjects(projectList.projects);
      setRuntimeState(runtimes);
      setSelectedProjectId((current) =>
        current &&
        projectList.projects.some((project) => project.projectId === current)
          ? current
          : (projectList.projects[0]?.projectId ?? null),
      );
      setSelectedId((current) =>
        current && next.some((run) => run.runId === current) ? current : null,
      );
      // Desktop 没有 HTTP/SSE 控制面；轮询只读取 Engine 的耐久完整快照。未完成
      // reasoning 与 delta 不进入 Journal，因此页面不会把半条模型输出误当结果。
      setConnected(true);
      setError(null);
    } catch (cause) {
      if(!valid())return;
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  /** 每次桌面页面启动自动完成发现与 ACP 验证；轮询绝不重复握手。 */
  useEffect(() => {
    if (!runtimeState || runtimeScanStarted.current) return;
    runtimeScanStarted.current = true;
    setRuntimeScanning(true);
    void api
      .scanCliRuntimes()
      .then((result) => {
        setRuntimeState(result.runtimes);
        setError(null);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setRuntimeScanning(false));
  }, [runtimeState]);
  /** 每次摘要来自 Desktop Engine，Tauri 只转写菜单栏文本，绝不维护第二份状态。 */
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const update = async () => {
      try {
        const status = await api.desktopStatus();
        const summary =
          status.activeRuns > 0
            ? `${status.activeRuns} 个运行中${status.blockedRuns ? `，${status.blockedRuns} 个等待决定` : ""}`
            : status.activeHarnesses > 0
              ? `${status.activeHarnesses} 个主控回合进行中`
              : "后台服务待命";
        await invoke("update_tray_summary", { summary });
      } catch {
        await invoke("update_tray_summary", {
          summary: "后台服务不可用",
        }).catch(() => {});
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const selected = runs.find((run) => run.runId === selectedId) ?? null;
  const taskBusy=harness?busyOperations[`task:${harness.harnessRunId}`]??null:null;
  const executionBusy=selectedExecutionId?busyOperations[`execution:${selectedExecutionId}`]??null:null;
  const runBusy=selectedId?busyOperations[`run:${selectedId}`]??null:null;
  useEffect(() => {
    if (!harness?.harnessRunId) return;
    let active = true;
    let request = 0;
    const refreshHarness = () => {
      const token = ++request;
      const valid=requestFence.current.begin(`task:${harness.harnessRunId}`);
      void api
        .harness(harness.harnessRunId)
        .then((response) => {
          if (active && token === request && valid()) setHarness(current=>current?newerTaskSnapshot(current,response.harness):current);
        })
        .catch((cause) =>
          { if (active && token === request && valid()) setError(cause instanceof Error ? cause.message : String(cause)); },
        );
    };
    refreshHarness();
    // 事件流为主通道；4 秒轮询只是断帧兜底。
    const timer = window.setInterval(refreshHarness, 4_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [harness?.harnessRunId]);

  /** Engine 事件驱动会话增量更新；条目先耐久后发布，事件与快照同源。 */
  useEffect(() => {
    const harnessRunId = harness?.harnessRunId;
    if (!harnessRunId) return;
    const tracker = createStreamTracker();
    let disposed = false;
    setLastEventAt(null);
    const resync = () => {
      const valid=requestFence.current.begin(`task:${harnessRunId}`);
      void api
        .harness(harnessRunId)
        .then((response) => {
          if (disposed || !valid()) return;
          setHarness(current=>current?newerTaskSnapshot(current,response.harness):current);
          setLastEventAt(Date.now());
        })
        .catch(() => {});
    };
    const unlisten = api.listenEngineEvents((envelope) => {
      if (disposed) return;
      if (envelope.frame.stream !== "harness") return;
      if (envelope.frame.harnessRunId !== harnessRunId) return;
      if(tracker.generation !== -1 && tracker.generation < envelope.generation)requestFence.current.advance();
      const decision = acceptEnvelope(tracker, envelope);
      if (decision === "skip") return;
      if (decision === "resync") {
        // generation 变化或漏帧：重读权威快照对齐（快照耐久包含该帧效果）。
        resync();
        return;
      }
      const event = envelope.frame.event;
      requestFence.current.begin(`task:${harnessRunId}`);
      if (
        event.type === "turn_finished" ||
        event.type === "turn_interrupted" ||
        event.type === "execution_changed"
      ) {
        // 这些事件不携带条目增量；重读一次获取 assistant 消息与最新状态。
        resync();
        return;
      }
      setHarness((current) =>
        current && current.harnessRunId === harnessRunId
          ? applyHarnessEventToSnapshot(current, event)
          : current,
      );
      setLastEventAt(Date.now());
    });
    return () => {
      disposed = true;
      void unlisten.then((release) => release());
    };
  }, [harness?.harnessRunId]);

  async function control(action: "pause" | "recover" | "stop" | "resume") {
    if (!selected) return;
    const finishBusy=beginBusy(`run:${selected.runId}`,action);
    try {
      const response = await api[action](selected.runId);
      setRuns((current) =>
        current.map((run) =>
          run.runId === response.runId ? toRunListItem(response) : run,
        ),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      finishBusy();
    }
  }


  async function createProject() {    try {
      const response = await api.createProject(projectCwd, projectTitle);
      setProjects((current) => [
        response.project,
        ...current.filter(
          (project) => project.projectId !== response.project.projectId,
        ),
      ]);
      setSelectedProjectId(response.project.projectId);
      setProjectCwd("");
      setProjectTitle("");
      setCreatingProject(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function beginHarnessDraft(projectId = selectedProjectId) {
    setHarnessView("active");
    if (!projectId) return;
    setSelectedProjectId(projectId);
    setDraftProjectId(projectId);
    setHarness(null);
    setHarnessText("");
    createRequest.current = null; setTaskTitle(""); setSelectedId(null);
    setWorkflowPanelOpen(false);
    setError(null);
  }
  async function sendHarness() {
    if (!harnessText.trim() || sending.current) return;
    sending.current = true; const owner = harness?.harnessRunId; const text = harnessText;
    const pageToken = navigationToken.current;
    try {
      if (harness) {
        await api.sendHarnessMessage(harness.harnessRunId, text);
        if(draftCacheRef.current.get(owner!)===text)draftCacheRef.current.set(owner!, "");
        const next = (await api.harness(owner!)).harness;
        if (harnessRef.current?.harnessRunId === owner) { setHarness(current=>current?newerTaskSnapshot(current,next):current); setHarnessText(draftCacheRef.current.get(owner!)??""); }
      } else {
        const projectId = draftProjectId ?? selectedProjectId;
        if (!projectId) return;
        const response = await api.startHarnessConversation(
          projectId,
          text,
          createRequest.current ?? (createRequest.current = crypto.randomUUID()),
          taskTitle || undefined,
        );
        setHarnesses((current) => [response.harness, ...current.filter(item=>item.harnessRunId !== response.harness.harnessRunId)]);
        if (navigationToken.current === pageToken && !harnessRef.current) {
          setHarness(response.harness); updateHarnessText(""); setDraftProjectId(null);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
    }
  }
  const selectExecution = useCallback(async (executionId: string,attempt?:number) => {
    if (!harness) return;
    const execution = harness.executions.find(item=>item.executionId === executionId);
    const revision = harness.workflowRevisions.find(item=>item.revision === execution?.revision);
    if (revision){openWorkflow(harness, revision, "execution", executionId);if(attempt)setRoute({kind:"workflow",taskId:harness.harnessRunId,cardId:revision.cardId??`legacy:${revision.revision}`,revision:revision.revision,section:"execution",executionId,attempt});}
  }, [harness]);
  useEffect(() => {
    if (!harness || !selectedExecutionId || route.kind !== "workflow" || route.taskId !== harness.harnessRunId) return;
    let active = true; setExecutionDetail(null);
    const owner = harness.harnessRunId;
    const reload = () => {
      const token = ++detailToken.current;
      const valid=requestFence.current.begin(`execution:${owner}:${selectedExecutionId}`);
      void api
        .execution(harness.harnessRunId, selectedExecutionId)
        .then((value) => {
          if (active && valid() && token === detailToken.current && harnessRef.current?.harnessRunId === owner) setExecutionDetail(value);
        })
        .catch((cause) => {
          if (active && valid())
            setError(executionLoadMessage(cause));
        });
    };
    reload();
    // 详情只经 Engine action 轮询；终态必须来自其 Journal/状态机投影，而非页面推断。
    // 面板打开期间无条件轮询：按旧快照状态过滤会让 resume 后的页面停在陈旧终态。
    const fallback = window.setInterval(reload, 1_000);
    return () => {
      active = false;
      window.clearInterval(fallback);
    };
  }, [harness?.harnessRunId, selectedExecutionId, route.kind]);
  async function finishAssignment(detail: ExecutionResponse) {
    if (!harness) return;
    const owner = harness.harnessRunId;
    const next = (await api.harness(owner)).harness;
    const executionRevision=next.workflowRevisions.find(item=>item.revision===detail.execution.revision);
    if(harnessRef.current?.harnessRunId!==owner||routeRef.current.kind!=="workflow"||executionRevision?.cardId!==routeRef.current.cardId)return;
    setHarness(current=>current?newerTaskSnapshot(current,next):current);
    setExecutionDetail(detail);setSelectedExecutionId(detail.execution.executionId);
    setRoute({...routeRef.current,revision:detail.execution.revision,section:"execution",executionId:detail.execution.executionId,attempt:undefined});
    setError(null);
  }
  /** 所有 Task mutation 回包共享同资源门禁；后台动作完成不改变当前导航。 */
  async function taskMutation(owner:string,operation:()=>Promise<{harness:HarnessSnapshot}>) {
    const valid=requestFence.current.begin(`task:${owner}`);
    const response=await operation();
    if(valid())setHarnesses(current=>current.map(item=>item.harnessRunId===owner?response.harness:item));
    if(valid()&&harnessRef.current?.harnessRunId===owner)setHarness(current=>current?newerTaskSnapshot(current,response.harness):current);
    return response;
  }
  async function controlExecution(
    action: "pause" | "recover" | "stop" | "resume",
  ) {
    if (!harness || !executionDetail) return;
    const valid=requestFence.current.begin(`execution:${harness.harnessRunId}:${executionDetail.execution.executionId}`);
    const finishBusy=beginBusy(`execution:${executionDetail.execution.executionId}`,`execution:${action}`);
    try {
      const detail =
        action === "resume"
          ? await api.resumeExecution(
              harness.harnessRunId,
              executionDetail.execution.executionId,
            )
          : await api.executionControl(
              harness.harnessRunId,
              executionDetail.execution.executionId,
              action,
            );
      const owner = harness.harnessRunId;
      if (valid() && harnessRef.current?.harnessRunId === owner && routeRef.current.kind === "workflow" && routeRef.current.executionId === detail.execution.executionId) setExecutionDetail(detail);
      const next = (await api.harness(owner)).harness;
      if (harnessRef.current?.harnessRunId === owner) setHarness(current=>current?newerTaskSnapshot(current,next):current);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      finishBusy();
    }
  }

  return (
    <main
      className={`agent-workbench theme-${theme} ${navOpen ? "nav-open" : ""}`}
    >
      <button ref={navigationButton} className="navigation-toggle" aria-label={navOpen?"关闭任务导航":"打开任务导航"} aria-expanded={navOpen} aria-controls="task-navigation" onClick={()=>setNavOpen(value=>!value)}>☰</button>
      {navOpen&&<button className="navigation-scrim" aria-label="关闭任务导航" onClick={()=>{setNavOpen(false);navigationButton.current?.focus();}} />}
      {error && (
        <div className="toast-layer" role="status" aria-live="polite">
          <div className="notice">
            <span>!</span>
            <div>{error}</div>
            <button aria-label="关闭错误提示" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        </div>
      )}
      <aside id="task-navigation" ref={navigationPanel} className="task-rail">
        <header>
          <div className="brand">
            <span className="brand-mark">W</span>
            <div>
              <strong>Wave Flow</strong>
              <span>本地主控工作台</span>
            </div>
          </div>
          <div className="rail-actions">
            <button
              className="theme-toggle"
              onClick={() =>
                setTheme((current) => (current === "dark" ? "light" : "dark"))
              }
              aria-label={
                theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"
              }
              title={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button
              className="settings-button"
              onClick={() => setSettingsOpen(true)}
              aria-label="主控与执行底座设置"
            >
              ⚙
            </button>
            <div
              className={`connection ${connected ? "online" : "offline"}`}
              title={connected ? "Desktop Engine 已连接" : "Desktop Engine 不可用"}
            >
              <i />
            </div>
          </div>
        </header>
        <button
          className="new-task"
          onClick={() => {
            if (selectedProjectId) beginHarnessDraft();
            else {
              setCreatingProject(true);
              setProjectCwd("");
              setProjectTitle("");
            }
          }}
        >
          ⊕ {selectedProjectId ? "新建任务" : "新建项目"}
        </button>
        <div className="task-section-title">
          <div className="harness-tabs" role="tablist" aria-label="会话状态">
            <button className={harnessView === "active" ? "active" : ""} onClick={() => setHarnessView("active")} role="tab" aria-selected={harnessView === "active"}>进行中</button>
            <button className={harnessView === "completed" ? "active" : ""} onClick={() => setHarnessView("completed")} role="tab" aria-selected={harnessView === "completed"}>已完成</button>
          </div>
          <button onClick={() => void refresh()} aria-label="刷新项目与会话">
            ↻
          </button>
        </div>
        <label className="task-search"><span>搜索任务</span><input value={search} onChange={event=>setSearch(event.target.value)} /></label>
        <nav className="task-list">
          {runs.length > 0 && <details><summary>独立运行历史</summary>{runs.map(run => <button key={run.runId} onClick={()=>{setHarness(null);setDraftProjectId(null);setRoute({kind:"conversation"});setSelectedId(run.runId);setNavOpen(false);}}>{run.workflow.name} · {localeTime(run.createdAt)} · {run.runId.slice(0,8)}</button>)}</details>}
          {projects.map((project) => (
            <ProjectGroup
              key={project.projectId}
              project={project}
              harnesses={harnesses.filter((item) => item.projectId === project.projectId && (!search || conversationTitle(item).includes(search) || item.workflowRevisions.some(revision=>revision.goal?.includes(search))) && (harnessView === "completed" ? item.status === "completed" : item.status !== "completed"))}
              route={route}
              onSelectWorkflow={openWorkflow}
              activeHarnessId={harness?.harnessRunId ?? null}
              unreadCounts={unreadCounts}
              showNewSession={harnessView === "active"}
              onSelectProject={() => {
                setSelectedProjectId(project.projectId);
                setHarness(null);
                setDraftProjectId(null);
                setRoute({kind:"conversation"}); setSelectedId(null);
              }}
              onNewSession={() => beginHarnessDraft(project.projectId)}
              onSelectHarness={(item) => {
                setSelectedProjectId(project.projectId);
                setHarness(item); setSelectedId(null); setRoute({kind:"conversation"}); setNavOpen(false);
                setDraftProjectId(null);
              }}
            />
          ))}
          {projects.length === 0 && <p>还没有项目，请从侧边栏创建。</p>}
        </nav>
        <footer>
          <span>桌面执行环境</span>
          <small>
            {connected ? "Desktop Engine 已连接" : "Desktop Engine 未连接"}
          </small>
        </footer>
      </aside>
      <section className="conversation-pane" hidden={workflowPanelOpen}>
        {!harness ? (
          <DraftConversation
            project={
              projects.find(
                (project) =>
                  project.projectId === (draftProjectId ?? selectedProjectId),
              ) ?? null
            }
            text={harnessText}
            onText={updateHarnessText}
            onSend={() => void sendHarness()}
            title={taskTitle} onTitle={setTaskTitle}
            onTemplate={()=>setTemplatePicker(true)}
          />
        ) : (
          <HarnessConversation
            harness={harness}
            text={harnessText}
            onText={updateHarnessText}
            onSend={() => void sendHarness()}
            onAbort={() => void api.abortHarness(harness.harnessRunId)}
            onComplete={() => {
              const finishBusy=beginBusy(`task:${harness.harnessRunId}`,"complete-harness");
              const pageToken=navigationToken.current;
              void taskMutation(harness.harnessRunId,()=>api.completeHarness(harness.harnessRunId))
                .then((response) => {
                  if(pageToken!==navigationToken.current||harnessRef.current?.harnessRunId!==response.harness.harnessRunId)return;
                  // 会话归档成功后，明确回到进行中视图的第一项目草稿页；不能依赖
                  // beginHarnessDraft 的早退或当前已完成会话的渲染状态。
                  const firstProjectId = projects[0]?.projectId ?? null;
                  setHarnessView("active");
                  setSelectedProjectId(firstProjectId);
                  setDraftProjectId(firstProjectId);
                  setHarness(null);
                  setHarnessText("");
                  setWorkflowPanelOpen(false);
                  setError(null);
                })
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(finishBusy);
            }}
            onOpenWorkflow={() => { const revision = workflowCells(harness).at(-1); if (revision) openWorkflow(harness,revision); }}
            hasWorkflow={harness.workflowRevisions.length > 0}
            onDraft={() => {}}
            onTemplate={()=>setTemplatePicker(true)}
            onAccept={async (revision) => {
              try {
                await taskMutation(harness.harnessRunId,()=>api.acceptWorkflowRevision(
                  harness.harnessRunId,
                  revision,
                ));
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              }
            }}
            onReject={async (revision) => {
              await taskMutation(harness.harnessRunId,()=>api.rejectWorkflowRevision(
                harness.harnessRunId,
                revision,
              ));
            }}
            onAssignmentCreated={(detail) => void finishAssignment(detail)}
            onSelectRevision={(revision) => openWorkflow(harness, revision, "plan")}
            onSelectExecution={(executionId,attempt) =>
              void selectExecution(executionId,attempt)
            }
            onAnswerDecision={async (decisionId, answer) => {
              const finishBusy=beginBusy(`task:${harness.harnessRunId}`,`decision:${decisionId}`);
              try {
                const response = await taskMutation(harness.harnessRunId,()=>api.answerHarnessDecision(
                  harness.harnessRunId,
                  decisionId,
                  answer,
                ));
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              } finally {
                finishBusy();
              }
            }}
            busy={taskBusy}
            lastEventAt={lastEventAt}
            visible={!workflowPanelOpen}
            onRead={markRead}
          />
        )}
        {templatePicker&&<TemplatePicker key={harness?.harnessRunId??`project:${draftProjectId??selectedProjectId}`} identity={harness?.harnessRunId??`project:${draftProjectId??selectedProjectId}`} blockedReason={harness&&(harness.status!=="idle"||harness.executions.some(item=>item.finishedAt===null))?"主控或执行仍在处理中；参数保留，结束后才能保存。":undefined} onClose={()=>setTemplatePicker(false)} onSave={async(selection,requestId)=>{
          const owner=harnessRef.current,token=navigationToken.current;
          const response=owner?await taskMutation(owner.harnessRunId,()=>api.saveTemplate(owner.harnessRunId,requestId,selection)):await api.createTemplateTask(draftProjectId??selectedProjectId!,"只读代码审查与独立复核",requestId,selection,taskTitle||undefined);
          setHarnesses(current=>[response.harness,...current.filter(item=>item.harnessRunId!==response.harness.harnessRunId)]);
          if(token===navigationToken.current&&(owner?harnessRef.current?.harnessRunId===owner.harnessRunId:!harnessRef.current)){
            if(selection.needsGuidance){
              setTemplatePicker(false);setHarness(response.harness);setDraftProjectId(null);setRoute({kind:"conversation"});
            }else openWorkflow(response.harness,response.harness.workflowRevisions.at(-1)!);
          }
        }}/>}
      </section>
      <aside
        ref={centralScroll}
        onScroll={()=>{if(route.kind==="workflow"&&centralScroll.current)detailPositions.set(pageKey,centralScroll.current.scrollTop);}}
        className="central-workflow" hidden={!workflowPanelOpen}
      >
        <WorkflowPanelErrorBoundary
          onClose={() => setWorkflowPanelOpen(false)}
        >
          <header className="workflow-page-header">
          <div>
            <span>
              {harness && route.kind === "workflow" ? `${conversationTitle(harness)} / 工作流` : "独立运行记录"}
            </span>
            <strong>
              {(route.kind === "workflow" ? harness?.workflowRevisions.find(item=>item.revision === route.revision)?.goal : null) ?? selected?.workflow.name ?? "工作流详情"}
            </strong>
          </div>
          <button
            onClick={() => setWorkflowPanelOpen(false)}
            aria-label="返回主控对话"
          >
            返回主控对话
          </button>
          </header>
          {harness && route.kind === "workflow" && !routeMatchesTask(harness,route) && <p role="alert">所选工作流记录已失效，请返回主控对话重新选择。</p>}
          {harness && route.kind === "workflow" && routeMatchesTask(harness,route) && (
            <div className="central-plan">
              <div className="workflow-page-tabs" role="tablist" aria-label="工作流详情" onKeyDown={event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;event.preventDefault();buttons[next]?.focus();buttons[next]?.click();}}>
              <button role="tab" aria-selected={route.section === "plan"} onClick={()=>setRoute({...route,section:"plan"})}>方案</button>
              <button role="tab" aria-selected={route.section === "execution"} disabled={!harness.executions.some(item=>item.revision === route.revision)} onClick={()=> { const ex = harness.executions.find(item=>item.revision === route.revision); if(ex) setSelectedExecutionId(ex.executionId); setRoute({...route,section:"execution",executionId:ex?.executionId,attempt:undefined}); }}>执行</button>
              <button role="tab" aria-selected={route.section === "results"} disabled={!harness.executions.some(item=>item.revision === route.revision)} onClick={()=>{const ex=harness.executions.find(item=>item.revision===route.revision);if(ex)setSelectedExecutionId(ex.executionId);setRoute({...route,section:"results",executionId:ex?.executionId});}}>结果</button>
              </div>
              {harness.status === "running" && <button onClick={()=>setRoute({kind:"conversation"})}>{harness.decisions.some(item=>!item.answer) ? "主控需要回答" : "主控正在处理"} · 返回对话</button>}
              {(unreadCounts.get(harness.harnessRunId)??0)>0&&<button onClick={()=>setRoute({kind:"conversation"})}>{unreadCounts.get(harness.harnessRunId)} 条未读 · 返回主控对话</button>}
              {harness.executions.filter(execution=>{const attention=harnesses.find(task=>task.harnessRunId===harness.harnessRunId)?.executionAttention?.[execution.executionId];return attention&&(attention.workerRequests>0||attention.scriptGates>0);}).map(execution=><button key={execution.executionId} onClick={()=>void selectExecution(execution.executionId)}>执行需要回答 · 前往所属执行</button>)}
              {route.section === "plan" && (()=> {
                const revisions=harness.workflowRevisions.filter(item=>(item.cardId ?? `legacy:${item.revision}`) === route.cardId);
                const revision=revisions.find(item=>item.revision === route.revision);
                if(!revision) return <p>方案不存在，请返回对话。</p>;
                return <><div className="workflow-version-toolbar"><label>方案版本<select value={revision.revision} onChange={event=>{setSelectedExecutionId(null);setExecutionDetail(null);setRoute({...route,revision:Number(event.target.value),executionId:undefined,attempt:undefined});}}>{revisions.map(item=><option key={item.revision} value={item.revision}>第 {item.revision} 版</option>)}</select></label><small>每次修改保留原方案，批准仅对当时的版本生效</small></div>
                  <WorkflowRevisionCard key={`${route.taskId}:${revision.revision}`} revision={revision} harness={harness} hideGoal
                    onSaved={next=>{setHarnesses(current=>current.map(item=>item.harnessRunId===next.harnessRunId?newerTaskSnapshot(item,next):item));if(harnessRef.current?.harnessRunId===next.harnessRunId&&routeRef.current.kind==="workflow"&&routeRef.current.cardId===revision.cardId&&routeRef.current.revision===revision.revision)openWorkflow(next,next.workflowRevisions.at(-1)!,"plan");}}
                    onAssignmentCreated={detail=>void finishAssignment(detail)} />
                  {editableRevision(harness,revision) && <><button onClick={()=>{ const request=`请修改工作流版本 ${revision.revision}（${revision.goal}）：\n`; if(!harnessText)updateHarnessText(request); else setError("已有对话草稿，请在原草稿中补充修改要求。"); setRoute({kind:"conversation"}); }}>请主控修改</button><button onClick={async()=>{ await taskMutation(harness.harnessRunId,()=>api.abandonCard(harness.harnessRunId,revision.cardId!)); }}>放弃候选</button></>}
                  {revision.abandonedAt && <p>候选已放弃，仅供查看。</p>}</>;
              })()}
              {route.section === "results" && executionDetail && <HistoricalResults key={executionDetail.execution.executionId} taskId={harness.harnessRunId} executionId={executionDetail.execution.executionId} currentAttempt={executionDetail.snapshot.currentExecutionAttemptId} />}
            </div>
          )}
          {executionDetail && harness && route.kind === "workflow" && routeMatchesTask(harness,route) && route.section === "execution" ? (
          <div className="workflow-detail-scroll">
            <ExecutionDetail
              detail={executionDetail}
              selectedAttempt={route.attempt}
              onSelectAttempt={attempt=>setRoute({...route,attempt})}
              busy={executionBusy}
              dynamicCount={executionDynamicCount}
              harnessRunId={harness.harnessRunId}
              onControl={controlExecution}
              onAnswerBlock={async (blockId, answer) => {
                const valid=requestFence.current.begin(`execution:${harness.harnessRunId}:${executionDetail.execution.executionId}`);
                const finishBusy=beginBusy(`execution:${executionDetail.execution.executionId}`,`answer:${blockId}`);
                try {
                  await api.answer(blockId, answer);
                  const next = await api.execution(
                    harness.harnessRunId,
                    executionDetail.execution.executionId,
                  );
                  if (valid() && harnessRef.current?.harnessRunId === harness.harnessRunId && routeRef.current.kind === "workflow" && routeRef.current.executionId === next.execution.executionId) setExecutionDetail(next);
                } finally {
                  finishBusy();
                }
              }}
              onAnswer={async (gateId, answer) => {
                const valid=requestFence.current.begin(`execution:${harness.harnessRunId}:${executionDetail.execution.executionId}`);
                const finishBusy=beginBusy(`execution:${executionDetail.execution.executionId}`,`gate:${gateId}`);
                try {
                  const next = await api.answerExecutionGate(
                    harness.harnessRunId,
                    executionDetail.execution.executionId,
                    gateId,
                    answer,
                  );
                  if (valid() && harnessRef.current?.harnessRunId === harness.harnessRunId && routeRef.current.kind === "workflow" && routeRef.current.executionId === next.execution.executionId) setExecutionDetail(next);
                } finally {
                  finishBusy();
                }
              }}
            />
          </div>
          ) : route.kind === "workflow" ? null : !selected ? (
          <div className="workflow-empty">
            <div>◇</div>
            <strong>等待主控发起 Workflow</strong>
            <p>
              已接受的草案会在对话中显示“创建执行”；Execution 启动后这里展示
              revision、attempt、Phase、Agent 与决策门。
            </p>
            {runs.length > 0 && (
              <>
                <span>当前独立运行记录</span>
                <div className="workflow-run-picker">
                  {runs.map((run) => (
                    <article key={run.runId}>
                      <button onClick={() => setSelectedId(run.runId)}>
                        <i className={`dot ${run.status}`} />
                        <div>
                          <strong>{run.workflow.name}</strong>
                          <small>{localeTime(run.createdAt)}</small>
                        </div>
                      </button>
                      <details>
                        <summary>诊断</summary>
                        <code>{run.runId}</code>
                      </details>
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
          ) : (
          <div className="workflow-detail-scroll">
            <RunDetail
              run={selected}
              busy={runBusy}
              onControl={control}
              onAnswer={async (blockId, answer) => {
                const finishBusy=beginBusy(`run:${selected.runId}`,`answer:${blockId}`);
                try {
                  await api.answer(blockId, answer);
                  await refresh();
                } finally {
                  finishBusy();
                }
              }}
            />
          </div>
          )}
        </WorkflowPanelErrorBoundary>
      </aside>
      {creatingProject && (
        <ProjectCreateModal
          cwd={projectCwd}
          title={projectTitle}
          onCwd={setProjectCwd}
          onTitle={setProjectTitle}
          onClose={() => setCreatingProject(false)}
          onCreate={() => void createProject()}
        />
      )}
      {settingsOpen && runtimeState?.harnessRuntimeId && (
        <RuntimeConnectionPanel
          runtimeState={runtimeState}
          scanning={runtimeScanning}
          onRuntimeState={setRuntimeState}
          onClose={() => setSettingsOpen(false)}
          onError={setError}
          theme={theme}
          onTheme={setTheme}
        />
      )}
      {runtimeState && !runtimeState.harnessRuntimeId && (
        <RuntimeConnectionPanel
          gateMode
          runtimeState={runtimeState}
          scanning={runtimeScanning}
          onRuntimeState={setRuntimeState}
          onError={setError}
        />
      )}
      {exitConfirmOpen && (
        <DesktopExitModal
          onClose={() => setExitConfirmOpen(false)}
          onError={setError}
        />
      )}
    </main>
  );
}

/** 将 Engine action 错误转换为可行动的桌面提示，避免误报 Workflow 失败。 */
function executionLoadMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  // invoke 路径下 Engine 断连/超时是稳定文案；旧 fetch 网络错误永远不会出现。
  if (/Desktop Engine (已退出|请求超时|管道错误|未运行)|无法发送 Engine 请求/.test(message)) {
    return "Desktop Engine 连接已中断；正在重新连接。若刚重启 Wave Flow，旧 Execution 会安全收敛为“已中断”，请在详情中显式恢复。";
  }
  return message;
}

/** 明确退出 Desktop；Engine 负责取消当前任务并回收它拥有的进程组。 */
function DesktopExitModal({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const shutdown = async () => {
    setBusy(true);
    try {
      await invoke("exit_desktop");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <div className="restart-backdrop" role="presentation">
      <section
        className="connection-panel restart-modal"
        role="dialog"
        aria-modal="true"
        aria-label="确认退出 Wave Flow"
      >
        <header className="connection-panel-head">
          <div>
            <span className="modal-kicker">Wave Flow</span>
            <strong>退出 Wave Flow？</strong>
            <p>
              这会停止正在进行的任务，并关闭 Wave Flow。
            </p>
          </div>
        </header>
        <section className="connection-form">
          <div className="restart-notice">
            <span>提示</span>
            <p>
              只是关闭窗口不会停止任务。确认退出后，任务会标记为已取消；下次可显式恢复。
            </p>
          </div>
          <footer className="modal-actions">
            <button
              className="button-secondary"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="button-danger"
              disabled={busy}
              onClick={() => void shutdown()}
            >
              {busy ? "正在退出…" : "退出 Wave Flow"}
            </button>
          </footer>
        </section>
      </section>
    </div>
  );
}

/** 设置分区标识：通用 / Agent CLI / 诊断。 */
type SettingsSection = "general" | "cli" | "diagnostics";

/** 完整显示的长路径 + 点击复制（就地"已复制"反馈）。 */
function CopyablePath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="wf-copyable-path">
      <code>{path}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            .writeText(path)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            })
            .catch(() => {});
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}

/** 发现来源的中文文案。 */
function discoveredFromLabel(from: CliRuntime["discoveredFrom"]): string {
  return from === "manual"
    ? "手动添加"
    : from === "gui-path"
      ? "从应用目录发现"
      : "从终端 PATH 发现";
}

function RuntimeConnectionPanel({
  gateMode = false,
  runtimeState,
  scanning,
  onRuntimeState,
  onClose,
  onError,
  theme,
  onTheme,
}: {
  gateMode?: boolean;
  runtimeState: CliRuntimeListResponse;
  scanning: boolean;
  onRuntimeState: (value: CliRuntimeListResponse) => void;
  onClose?: () => void;
  onError: (value: string) => void;
  /** 当前主题（通用分区展示与切换）；gate 模式不展示通用分区，可为空。 */
  theme?: ColorTheme;
  /** 切换主题回调。 */
  onTheme?: (theme: ColorTheme) => void;
}) {
  const [manualPath, setManualPath] = useState("");
  const [manualCli, setManualCli] = useState<"codex" | "kimi">("codex");
  const [manualOpen, setManualOpen] = useState(false);
  /** 手动验证失败必须在二级弹窗内可见；全局 toast 只是补充，不作为唯一反馈。 */
  const [manualError, setManualError] = useState<string | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  /** WKWebView 不支持 window.confirm；切换主控用两段式按钮确认，timer 只负责超时复位。 */
  const [confirmSwitchId, setConfirmSwitchId] = useState<string | null>(null);
  const confirmSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [section, setSection] = useState<SettingsSection>("cli");
  const [engineStatus, setEngineStatus] = useState<DesktopStatusResponse | null>(null);
  const [engineStatusError, setEngineStatusError] = useState<string | null>(null);
  const selected =
    runtimeState.runtimes.find(
      (runtime) => runtimeState.harnessRuntimeId === runtime.runtimeId,
    ) ?? null;
  const reloadRuntimes = useCallback(async () => {
    onRuntimeState(await api.cliRuntimes());
  }, [onRuntimeState]);
  const loadEngineStatus = useCallback(async () => {
    try {
      setEngineStatus(await api.desktopStatus());
      setEngineStatusError(null);
    } catch (cause) {
      setEngineStatusError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (section === "diagnostics") void loadEngineStatus();
  }, [section, loadEngineStatus]);
  async function scan() {
    // PATH 扫描护栏：进行中禁止重复触发；结果写回 App 级 runtimeState，
    // 扫描期间切换分区不会丢弃返回结果。
    if (runtimeBusy || scanning) return;
    setRuntimeBusy(true);
    try {
      onRuntimeState((await api.scanCliRuntimes()).runtimes);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRuntimeBusy(false);
    }
  }
  async function validate() {
    if (!manualPath.trim()) return;
    setRuntimeBusy(true);
    setManualError(null);
    try {
      await api.validateCliRuntime(manualPath.trim(), manualCli);
      await reloadRuntimes();
      setManualPath("");
      setManualOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setManualError(message);
      onError(message);
    } finally {
      setRuntimeBusy(false);
    }
  }
  async function selectRuntime(runtime: CliRuntime) {
    if (selected && selected.runtimeId !== runtime.runtimeId && confirmSwitchId !== runtime.runtimeId) {
      // 第一次点击只进入待确认态；4 秒内再次点击才执行切换。
      setConfirmSwitchId(runtime.runtimeId);
      if (confirmSwitchTimer.current) clearTimeout(confirmSwitchTimer.current);
      confirmSwitchTimer.current = setTimeout(() => setConfirmSwitchId(null), 4_000);
      return;
    }
    setConfirmSwitchId(null);
    setRuntimeBusy(true);
    try {
      await api.selectCliRuntime(runtime.runtimeId);
      await reloadRuntimes();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRuntimeBusy(false);
    }
  }

  const cliContent = (
    <>
      <section className="runtime-status" aria-live="polite">
        {selected ? (
          <>
            <div className="status-mark verified">✓</div>
            <div>
              <span>当前主控 CLI</span>
              <strong>
                {selected.cli === "codex" ? "Codex CLI" : "Kimi CLI"}
              </strong>
              <CopyablePath path={selected.executablePath} />
              <small>
                {selected.version} · ACP adapter{" "}
                {selected.verifiedAdapter.adapterVersion}
              </small>
            </div>
            <em>已验证</em>
          </>
        ) : (
          <>
            <div className={`status-mark ${scanning ? "scanning" : ""}`}>
              {scanning ? "···" : "◇"}
            </div>
            <div>
              <span>
                {scanning ? "正在检查本机 CLI" : "尚未设置主控 CLI"}
              </span>
              <strong>
                {scanning ? "发现并验证可用候选" : "请选择一个已验证候选"}
              </strong>
              <small>
                {scanning
                  ? "正在安全验证 PATH 中的候选；不会修改默认项。"
                  : "设置后才可进入工作台；手动添加不会自动设为主控。"}
              </small>
            </div>
          </>
        )}
      </section>
      <section className="connection-form runtime-actions">
        <div className="section-row">
          <div>
            <strong>{selected ? "可用 CLI" : "已验证候选"}</strong>
            <span>
              {selected
                ? "切换主控只影响新会话；进行中的主控回合会阻止切换。"
                : "从 PATH 自动发现，或手动添加一个绝对路径。"}
            </span>
          </div>
          {!gateMode && (
            <button
              className="button-secondary"
              disabled={runtimeBusy || scanning}
              onClick={() => void scan()}
            >
              {runtimeBusy || scanning ? "正在扫描…" : "重新扫描"}
            </button>
          )}
        </div>
        <button
          className="button-secondary add-runtime"
          disabled={runtimeBusy}
          onClick={() => {
            setManualError(null);
            setManualOpen(true);
          }}
        >
          手动添加 CLI
        </button>
      </section>
      <section className="runtime-list">
        <span className="list-caption">
          {runtimeState.runtimes.length
            ? "已验证 Runtime"
            : scanning
              ? "正在验证候选…"
              : "尚未发现可用 CLI"}
        </span>
        {runtimeState.runtimes.map((runtime) => (
          <article
            key={runtime.runtimeId}
            className={
              runtimeState.harnessRuntimeId === runtime.runtimeId
                ? "selected"
                : ""
            }
          >
            <div>
              <strong>
                {runtime.cli === "codex" ? "Codex CLI" : "Kimi CLI"}
                <span className="runtime-cli-badge">{runtime.cli}</span>
              </strong>
              <CopyablePath path={runtime.executablePath} />
              <small>
                {runtime.version} · {discoveredFromLabel(runtime.discoveredFrom)} · adapter {runtime.verifiedAdapter.adapterId} ·{" "}
                {runtime.verifiedAdapter.harnessTools ? "主控 + Worker" : "Worker"}
              </small>
              {runtime.diagnostic && <p>{runtime.diagnostic}</p>}
            </div>
            {runtimeState.harnessRuntimeId === runtime.runtimeId ? (
              <span className="runtime-selected">当前主控</span>
            ) : runtime.status === "verified" &&
              runtime.verifiedAdapter.harnessTools ? (
              <button
                className="button-primary"
                disabled={runtimeBusy}
                onClick={() => void selectRuntime(runtime)}
              >
                {confirmSwitchId === runtime.runtimeId
                  ? "确认切换主控？"
                  : "设为主控"}
              </button>
            ) : (
              <span className="runtime-passive">可用候选</span>
            )}
          </article>
        ))}
      </section>
      {manualOpen && (
        <div
          className="connection-nested-backdrop"
          onMouseDown={() => setManualOpen(false)}
        >
          <section
            className="connection-panel connection-panel--nested"
            aria-label="手动添加 CLI"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="connection-panel-head">
              <div>
                <span className="modal-kicker">手动添加</span>
                <strong>验证本机 CLI</strong>
                <p>
                  输入绝对路径。验证会完成 realpath、版本与 ACP
                  握手；成功后只加入候选列表。
                </p>
              </div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setManualOpen(false)}
                aria-label="关闭手动添加"
              >
                ×
              </button>
            </header>
            <section className="connection-form">
              <label className="connection-field">
                <span>CLI 种类</span>
                <select
                  value={manualCli}
                  onChange={(event) =>
                    setManualCli(event.target.value as "codex" | "kimi")
                  }
                >
                  <option value="codex">Codex CLI</option>
                  <option value="kimi">Kimi CLI</option>
                </select>
              </label>
              <label className="connection-field">
                <span>CLI 绝对路径</span>
                <input
                  autoFocus
                  value={manualPath}
                  onChange={(event) => setManualPath(event.target.value)}
                  placeholder={
                    manualCli === "kimi"
                      ? "/Users/you/.kimi-code/bin/kimi"
                      : "/Users/you/.local/bin/codex"
                  }
                  spellCheck={false}
                />
              </label>
              {manualError && (
                <div className="manual-runtime-error" role="alert">
                  <span>!</span>
                  <p>{manualError}</p>
                </div>
              )}
              <footer className="modal-actions">
                <button
                  className="button-secondary"
                  onClick={() => setManualOpen(false)}
                >
                  取消
                </button>
                <button
                  className="button-primary"
                  disabled={runtimeBusy || !manualPath.trim()}
                  onClick={() => void validate()}
                >
                  {runtimeBusy ? "正在验证…" : "验证并添加"}
                </button>
              </footer>
            </section>
          </section>
        </div>
      )}
    </>
  );

  if (gateMode) {
    return (
      <div className="settings-backdrop connection-backdrop connection-backdrop--gate">
        <section
          className="connection-panel runtime-settings runtime-settings--gate"
          aria-label="选择主控 CLI"
          aria-modal="true"
          role="dialog"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="connection-panel-head">
            <div>
              <span className="modal-kicker">本机执行底座</span>
              <strong>选择主控 CLI</strong>
              <p>
                Wave Flow 需要一个已验证的本机 CLI 才能开始主控会话。扫描只会发现候选，默认项始终由你明确设定。
              </p>
            </div>
          </header>
          {cliContent}
        </section>
      </div>
    );
  }

  return (
    <div
      className="settings-backdrop connection-backdrop"
      onMouseDown={onClose}
    >
      <section
        className="connection-panel runtime-settings settings-panel"
        aria-label="设置"
        aria-modal="true"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="connection-panel-head">
          <div>
            <span className="modal-kicker">Wave Flow</span>
            <strong>设置</strong>
          </div>
          <button
            className="modal-close"
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ×
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
            {(
              [
                ["general", "通用"],
                ["cli", "Agent CLI"],
                ["diagnostics", "诊断"],
              ] as Array<[SettingsSection, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={section === key ? "active" : ""}
                aria-current={section === key}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {section === "general" && (
              <section className="settings-section">
                <div className="section-row">
                  <div>
                    <strong>外观主题</strong>
                    <span>明暗外观立即生效，并同步 macOS 原生标题栏。</span>
                  </div>
                </div>
                <div className="settings-theme" role="radiogroup" aria-label="外观主题">
                  <label>
                    <input
                      type="radio"
                      name="settings-theme"
                      checked={theme === "dark"}
                      onChange={() => onTheme?.("dark")}
                    />
                    深色
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="settings-theme"
                      checked={theme === "light"}
                      onChange={() => onTheme?.("light")}
                    />
                    浅色
                  </label>
                </div>
              </section>
            )}
            {section === "cli" && cliContent}
            {section === "diagnostics" && (
              <section className="settings-section">
                <div className="section-row">
                  <div>
                    <strong>Desktop Engine 状态</strong>
                    <span>来自 Engine 权威摘要；页面不由此推断或改变 Run 状态。</span>
                  </div>
                  <button
                    className="button-secondary"
                    onClick={() => void loadEngineStatus()}
                  >
                    刷新
                  </button>
                </div>
                {engineStatus ? (
                  <dl className="settings-diag-list">
                    <dt>协议版本</dt>
                    <dd>{engineStatus.protocolVersion}</dd>
                    <dt>运行中的 Run</dt>
                    <dd>{engineStatus.activeRuns}</dd>
                    <dt>等待决定的 Run</dt>
                    <dd>{engineStatus.blockedRuns}</dd>
                    <dt>进行中的主控回合</dt>
                    <dd>{engineStatus.activeHarnesses}</dd>
                    <dt>待恢复的 ACP Worker</dt>
                    <dd>{engineStatus.acpWorkersNeedingResume}</dd>
                  </dl>
                ) : engineStatusError ? (
                  <p className="manual-runtime-error">{engineStatusError}</p>
                ) : (
                  <p className="settings-note">正在读取…</p>
                )}
                <div className="section-row">
                  <div>
                    <strong>当前主控 Runtime 来源</strong>
                    <span>用于审计本机执行底座的真实落点。</span>
                  </div>
                </div>
                {selected ? (
                  <dl className="settings-diag-list">
                    <dt>CLI</dt>
                    <dd>{selected.cli === "codex" ? "Codex CLI" : "Kimi CLI"}</dd>
                    <dt>路径</dt>
                    <dd><CopyablePath path={selected.executablePath} /></dd>
                    <dt>版本</dt>
                    <dd>{selected.version}</dd>
                    <dt>发现来源</dt>
                    <dd>{discoveredFromLabel(selected.discoveredFrom)}{selected.discoveredShell ? `（${selected.discoveredShell}）` : ""}</dd>
                    <dt>验证 Adapter</dt>
                    <dd>{selected.verifiedAdapter.adapterId} · {selected.verifiedAdapter.adapterVersion} · ACP v{selected.verifiedAdapter.acpProtocolVersion}</dd>
                    <dt>验证时间</dt>
                    <dd>{localeTime(selected.verifiedAt)}</dd>
                  </dl>
                ) : (
                  <p className="settings-note">尚未设置主控 CLI。</p>
                )}
              </section>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Workflow 详情来自独立 Execution 快照；详情渲染异常只能降级右栏，不能卸载
 * 仍可继续输入与查看会话的主工作台。关闭后由下一次显式打开重新尝试渲染。
 */
class WorkflowPanelErrorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="workflow-render-error" role="alert">
          <strong>无法显示 Workflow 详情</strong>
          <p>详情数据暂时不可用；对话和运行不会因此停止。</p>
          <button onClick={this.props.onClose}>关闭详情</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function HarnessListItem({
  item,
  active,
  onClick,
  unread=0,
}: {
  item: HarnessSnapshot;
  active: boolean;
  onClick: () => void;
  /** 未阅读的耐久条目数；不按流式片段计数。 */
  unread?: number;
}) {
  return (
    <button
      className={`harness-list-item ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className={`task-presence ${item.status}`} />
      <div>
        <strong>{conversationTitle(item)}</strong>
        {unread>0 && <span className="task-unread">{unread} 条未读</span>}
        <small>
          {item.status === "running"
            ? "进行中"
            : item.status === "interrupted"
              ? "已中断"
              : item.status === "completed"
                ? "已完成"
              : "待命"}{" "}
          · {localeTime(item.completedAt ?? item.createdAt)}
          {item.executions.some(execution=>execution.finishedAt === null) && " · 工作流运行中"}
          {item.decisions.some(decision=>decision.answer === null) && item.status === "running" && " · 主控需要回答"}
          {Object.values(item.executionAttention ?? {}).some(value=>value.workerRequests>0||value.scriptGates>0) && " · 执行需要回答"}
        </small>
      </div>
    </button>
  );
}
function TaskTreeItem({item,active,route,unread,onClick,onWorkflow}:{item:HarnessSnapshot;unread:number;active:boolean;route:WorkbenchRoute;onClick:()=>void;onWorkflow:(revision:import("./types").WorkflowRevision)=>void}) {
  const [expanded,setExpanded]=useState(()=>taskExpansions.get(item.harnessRunId)??false);
  useEffect(()=>{if(route.kind==="workflow" && route.taskId===item.harnessRunId)setExpanded(true);},[route.kind==="workflow" ? route.cardId : null]);
  return <div className="task-tree-item"><div className="task-tree-row"><button aria-label={`${expanded?"收起":"展开"} ${conversationTitle(item)} 工作流`} aria-expanded={expanded} onClick={()=>setExpanded(value=>{taskExpansions.set(item.harnessRunId,!value);return !value;})}>{expanded?"⌄":"›"}</button><HarnessListItem item={item} unread={unread} active={active && route.kind==="conversation"} onClick={onClick}/></div>{expanded && <ul>{workflowCells(item).map(revision=>{const execution=item.executions.find(ex=>ex.revision===revision.revision);const attention=execution?item.executionAttention?.[execution.executionId]:undefined;const help=attention&&attention.workerRequests+attention.scriptGates>0;return <li key={revision.cardId ?? revision.revision}><button aria-current={active && route.kind==="workflow" && route.cardId===(revision.cardId ?? `legacy:${revision.revision}`) ? "page":undefined} onClick={()=>onWorkflow(revision)}><strong>{revision.goal ?? `历史方案 ${revision.revision}`}</strong><small>{help?`需要回答 · ${attention!.workerRequests} 个 Worker / ${attention!.scriptGates} 个确认`:revision.abandonedAt?"已放弃":execution?"执行记录":revision.acceptedAt?"待运行":revision.rejectedAt?"需修改":"待确认"}</small></button></li>;})}</ul>}</div>;
}
function ProjectGroup({
  project,
  harnesses,
  activeHarnessId,
  unreadCounts,
  route, onSelectWorkflow,
  showNewSession,
  onSelectProject,
  onNewSession,
  onSelectHarness,
}: {
  project: HarnessProject;
  harnesses: HarnessSnapshot[];
  activeHarnessId: string | null;
  /** 各 Task 的本地阅读计数；不构成业务状态。 */
  unreadCounts: Map<string,number>;
  route: WorkbenchRoute;
  onSelectWorkflow: (task: HarnessSnapshot, revision: import("./types").WorkflowRevision, section?: "plan" | "execution" | "results", executionId?: string) => void;
  showNewSession: boolean;
  onSelectProject: () => void;
  onNewSession: () => void;
  onSelectHarness: (harness: HarnessSnapshot) => void;
}) {
  return (
    <section className="project-group">
      <header>
        <button onClick={onSelectProject}>
          <span className="folder-glyph" aria-hidden="true">
            ⌑
          </span>
          <strong>{project.title}</strong>
        </button>
        {showNewSession && (
          <button
            className="project-new-session"
            onClick={onNewSession}
            aria-label={`在 ${project.title} 新建会话`}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 3.25v9.5M3.25 8h9.5" />
            </svg>
          </button>
        )}
      </header>
      {harnesses.length > 0 ? (
        <div className="project-conversations">
          {harnesses.map((item) => (
            <TaskTreeItem key={item.harnessRunId} item={item} unread={unreadCounts.get(item.harnessRunId)??0} active={item.harnessRunId === activeHarnessId} route={route} onClick={()=>onSelectHarness(item)} onWorkflow={revision=>onSelectWorkflow(item,revision)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
function ProjectCreateModal({
  cwd,
  title,
  onCwd,
  onTitle,
  onClose,
  onCreate,
}: {
  cwd: string;
  title: string;
  onCwd: (value: string) => void;
  onTitle: (value: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div
      className="settings-backdrop connection-backdrop"
      onMouseDown={onClose}
    >
      <section
        className="connection-panel project-create"
        aria-label="添加本地项目"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="connection-panel-head">
          <div>
            <span className="modal-kicker">侧边栏项目</span>
            <strong>添加本地项目</strong>
            <p>项目路径只在这里登记。之后可在同一项目下持续创建主控会话。</p>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="关闭创建项目"
          >
            ×
          </button>
        </header>
        <section className="connection-form project-fields">
          <label className="connection-field">
            <span>项目路径</span>
            <input
              value={cwd}
              onChange={(event) => onCwd(event.target.value)}
              placeholder="/绝对路径/项目目录"
              autoFocus
            />
          </label>
          <label className="connection-field">
            <span>
              显示名称 <i>可选</i>
            </span>
            <input
              value={title}
              onChange={(event) => onTitle(event.target.value)}
              placeholder="默认使用目录名"
            />
          </label>
        </section>
        <footer className="modal-actions">
          <button className="button-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button-primary"
            disabled={!cwd.trim()}
            onClick={onCreate}
          >
            创建项目
          </button>
        </footer>
      </section>
    </div>
  );
}

/** 仅由浏览器维护的新会话草稿；首次发送前不会创建 Harness、目录或 Journal。 */
function DraftConversation({
  project,
  text,
  onText,
  onSend,
  title, onTitle,
  onTemplate,
}: {
  project: HarnessProject | null;
  text: string;
  onText: (value: string) => void;
  onSend: () => void;
  title: string; onTitle: (value: string) => void;
  /** 打开预置来源；不创建任务。 */ onTemplate:()=>void;
}) {
  const ready = project !== null;
  return (
    <div className="conversation draft-conversation">
      <header>
        <div>
          <span className="task-presence" />
          <div>
            <strong>新建任务</strong>
            <small>{project?.title ?? "未选择项目"}</small>
          </div>
        </div>
        <div className="conversation-actions">
        </div>
      </header>
      <div className="conversation-scroll">
        <div className="conversation-intro">
          <span>自动编排</span>
          <div className="task-source-options"><button aria-pressed="true">自动编排</button><button onClick={onTemplate} disabled={!ready}>预置工作流</button><button disabled>本地工作流 · 尚未开放</button></div>
          <label>任务标题（可选）<input value={title} maxLength={120} onChange={event=>onTitle(event.target.value)} /></label>
          <h2>你想完成什么任务？</h2>
          <p>
            先告诉我目标和约束。发送第一条消息后，这条会话才会保存到当前项目。
          </p>
        </div>
      </div>
      <div className="conversation-composer">
        <textarea
          autoFocus
          value={text}
          disabled={!ready}
          onChange={(event) => onText(event.target.value)}
          placeholder={ready ? "给主控发送消息" : "请先选择项目"}
          onKeyDown={(event) => {
            if (shouldSubmitComposer(event)) {
              event.preventDefault();
              if (text.trim() && ready) onSend();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-guidance">
            <span aria-hidden="true">＋</span>
            <small>
              ⌘/Ctrl + Enter 发送 · Enter 换行 · 未发送内容不会创建会话
            </small>
          </div>
          <button
            className="send-message"
            aria-label="发送消息"
            disabled={!ready || !text.trim()}
            onClick={onSend}
          >
            ↑
          </button>
        </div>
      </div>

    </div>
  );
}

function HarnessConversation({
  harness,
  text,
  onText,
  onSend,
  onAbort,
  onOpenWorkflow,
  hasWorkflow,
  onDraft,
  onTemplate,
  onAccept,
  onReject,
  onAssignmentCreated,
  onSelectExecution,
  onSelectRevision,
  onAnswerDecision,
  onComplete,
  busy,
  lastEventAt,
  visible,
  onRead,
}: {
  harness: HarnessSnapshot;
  text: string;
  onText: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onOpenWorkflow: () => void;
  hasWorkflow: boolean;
  onDraft: () => void;
  /** 用户显式选择预置工作流，不自动执行。 */ onTemplate:()=>void;
  onAccept: (revision: number) => void;
  /** 拒绝草案；最新会话快照由调用方写回 state。 */
  onReject: (revision: number) => Promise<void>;
  onAssignmentCreated: (detail: ExecutionResponse) => void;
  onSelectExecution: (executionId: string,attempt?:number) => void;
  onSelectRevision: (revision: import("./types").WorkflowRevision) => void;
  onAnswerDecision: (
    decisionId: string,
    answer: Record<string, unknown>,
  ) => Promise<void>;
  onComplete: () => void;
  busy: string | null;
  /** 最近一次条目事件到达时间（Date.now() 毫秒）；无事件时为 null。 */
  lastEventAt: number | null;
  /** 当前主控页可见性，隐藏页不能清未读。 */
  visible:boolean;
  /** 当前视口耐久身份阅读回调。 */
  onRead:(taskId:string,ids:string[])=>void;
}) {
  return (
    <ConversationView
      key={harness.harnessRunId}
      harness={harness}
      draft={text}
      onDraft={onText}
      onSend={onSend}
      onAbort={onAbort}
      onComplete={onComplete}
      onOpenWorkflow={onOpenWorkflow}
      hasWorkflow={hasWorkflow}
      busy={busy}
      lastEventAt={lastEventAt}
      visible={visible}
      onRead={onRead}
      timelineEvents={[
        ...harness.workflowRevisions.map(revision => ({ key: `revision:${revision.revision}`, at: revision.createdAt, content: <WorkflowProposalSummary task={harness} revision={revision} onOpen={()=>onSelectRevision(revision)} /> })),
        ...(harness.executionHistory?.length?harness.executionHistory.map(item=>{const execution=harness.executions.find(execution=>execution.executionId===item.executionId);return {key:item.key,at:item.at,content:execution?<WorkflowExecutionSummary attempt={item.attempt} execution={{...execution,status:item.status,diagnostic:item.diagnostic,summary:item.summary}} revision={harness.workflowRevisions.find(revision=>revision.revision===item.revision)} onOpen={()=>onSelectExecution(item.executionId,item.attempt)} />:null};}):harness.executions.map(execution => ({ key: `execution:${execution.executionId}`, at: execution.createdAt, content: <WorkflowExecutionSummary execution={execution} revision={harness.workflowRevisions.find(revision=>revision.revision===execution.revision)} onOpen={()=>onSelectExecution(execution.executionId)} /> }))),
      ]}
    >
      {harness.task&&<button onClick={()=>{const latest=harness.workflowRevisions.at(-1);if(latest&&editableRevision(harness,latest))onSelectRevision(latest);else onTemplate();}} disabled={harness.status!=="idle"||harness.executions.some(item=>item.finishedAt===null)}>{harness.workflowRevisions.at(-1)&&editableRevision(harness,harness.workflowRevisions.at(-1)!)?"继续准备工作流":"运行工作流 → 选择工作流"}</button>}
      {harness.task && harness.diagnostic?.includes("主控启动失败") && <button onClick={()=>void api.retryInitialization(harness.harnessRunId)}>重试启动主控（不重复创建任务）</button>}
        {harness.decisions
          .filter((decision) => decision.answer === null && harness.status === "running")
          .map((decision) => (
            <HarnessDecisionCard
              key={decision.decisionId}
              decision={decision}
              busy={busy === `decision:${decision.decisionId}`}
              onAnswer={async (answer) =>
                onAnswerDecision(decision.decisionId, answer)
              }
            />
          ))}
    </ConversationView>
  );
}

/**
 * 裸 Enter 始终留给 textarea 与 IME：它可确认中文候选、切换输入状态或换行。
 * 发送只接受显式的 ⌘/Ctrl + Enter，且 composition 期间一律不拦截事件。
 * 实现复用 conversation 模块的同一判定。
 */
function shouldSubmitComposer(
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
): boolean {
  return conversationShouldSubmitComposer(event);
}

function ExecutionAction({
  execution,
  onSelect,
}: {
  execution: WorkflowExecution;
  onSelect: () => void;
}) {
  return (
    <article className="conversation-action execution-action">
      <span>Execution · revision v{execution.revision}</span>
      <code>
        {execution.executionId.slice(0, 12)} · attempt 由详情 Journal 记录
      </code>
      <p>
        <Status status={execution.status} />{" "}
        {execution.finishedAt
          ? `结束于 ${localeTime(execution.finishedAt)}`
          : "正在或等待执行"}
      </p>
      {execution.diagnostic && (
        <p className="diagnostic">{execution.diagnostic}</p>
      )}
      <button onClick={onSelect}>查看执行详情</button>
    </article>
  );
}

function HarnessDecisionCard({
  decision,
  busy,
  onAnswer,
}: {
  decision: HarnessDecision;
  busy: boolean;
  onAnswer: (answer: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <article className="conversation-action harness-decision">
      <span>主控需要你的决定</span>
      <p>{decision.question}</p>
      {decision.answerSchema ? (
        <SchemaForm
          schema={decision.answerSchema}
          busy={busy}
          submitLabel="提交决定"
          onSubmit={onAnswer}
        />
      ) : (
        <FreeJsonAnswer busy={busy} submitLabel="提交决定" onSubmit={onAnswer} />
      )}
    </article>
  );
}

/** 原 attempt 的只读证据；切换或迟到响应不污染其他任务。 */
function HistoricalResults({taskId,executionId,currentAttempt}:{taskId:string;executionId:string;currentAttempt:number}) {
  const resultKey=`${taskId}:${executionId}`;
  const [attempt,setAttempt]=useState(()=>{const saved=resultAttempts.get(resultKey);return saved&&saved<=currentAttempt?saved:currentAttempt;});
  useEffect(()=>resultAttempts.set(resultKey,attempt),[resultKey,attempt]);
  const [value,setValue]=useState<Awaited<ReturnType<typeof api.attemptResults>>|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;setValue(null);setError(null);void api.attemptResults(taskId,executionId,attempt).then(value=>{if(active)setValue(value);}).catch(error=>{if(active)setError(String(error));});return()=>{active=false;};},[taskId,executionId,attempt]);
  return <section className="workflow-results"><h2>执行结果</h2><p>仅展示所选执行尝试的耐久证据，不代表目标已验收；自动汇总尚未开放。</p><label>执行尝试<select value={attempt} onChange={event=>setAttempt(Number(event.target.value))}>{Array.from({length:currentAttempt},(_,index)=><option key={index+1} value={index+1}>attempt #{index+1}{index+1===currentAttempt?"（当前）":"（历史）"}</option>)}</select></label>{error&&<p role="alert">{error}</p>}{!value&&!error&&<p>正在读取原执行结果…</p>}{value&&<><p>原终态：{value.status??"未保存终态"}。该视图只读，不恢复执行。</p><h2>工作流返回结果</h2>{value.summary?<pre>{JSON.stringify(value.summary,null,2)}</pre>:<p>该尝试未保存工作流返回结果。</p>}<h2>节点交付</h2>{value.nodes.length===0&&<p>该尝试没有已完成节点。</p>}{value.nodes.map(node=><PersistedDetails identity={`${taskId}:${executionId}:${attempt}:${node.id}:result`} key={node.id}><summary>{node.label}</summary><pre>{JSON.stringify(node.result,null,2)}</pre></PersistedDetails>)}</>}</section>;
}

function ExecutionDetail({
  detail,
  selectedAttempt,
  onSelectAttempt,
  busy,
  dynamicCount,
  harnessRunId,
  onControl,
  onAnswer,
  onAnswerBlock,
}: {
  detail: ExecutionResponse;
  busy: string | null;
  /** 该 revision 静态无法枚举的动态节点数；0 表示无动态节点或不可用。 */
  dynamicCount: number;
  /** 所属 Harness Run id；用于跨 attempt 读取耐久 Phase 访问（复用分组）。 */
  harnessRunId: string;
  onControl: (action: "pause" | "recover" | "stop" | "resume") => Promise<void>;
  onAnswer: (gateId: string, answer: Record<string, unknown>) => Promise<void>;
  onAnswerBlock: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
  /** 阅读指定耐久 attempt；缺省显示当前执行，不改变业务状态。 */
  selectedAttempt?: number;
  /** 只更新阅读路由，不恢复或派发。 */
  onSelectAttempt?: (attempt: number) => void;
}) {
  const executionId = detail.execution.executionId;
  const [allVisits, setAllVisits] = useState<PhaseVisit[]>([]);
  /** 跨 attempt 读取全部耐久 Phase 访问；稳定引用避免随快照轮询重复拉取。 */
  const loadAllVisits = useCallback(async () => {
    const items: import("./types").PhaseVisit[] = [];
    let cursor: number | null = null;
    // 顺序翻页直到读完全部 attempt 的耐久访问记录（上限防止异常循环）。
    for (let page = 0; page < 10; page += 1) {
      const response = await api.executionPhaseVisits(
        harnessRunId,
        executionId,
        cursor === null ? {} : { cursor },
      );
      items.push(...response.items);
      cursor = response.nextCursor;
      if (cursor === null) break;
    }
    return items;
  }, [harnessRunId, executionId]);
  useEffect(() => {
    let active = true;
    void loadAllVisits().then(items => { if (active) setAllVisits(items); }).catch(() => {});
    return () => { active = false; };
  }, [loadAllVisits, detail.snapshot.currentExecutionAttemptId, detail.snapshot.status]);
  const attemptIds = [...new Set([detail.snapshot.currentExecutionAttemptId, ...allVisits.map(visit=>visit.executionAttemptId)])].sort((a,b)=>a-b);
  const readingAttempt = selectedAttempt ?? detail.snapshot.currentExecutionAttemptId;
  const historical = readingAttempt !== detail.snapshot.currentExecutionAttemptId;
  if(selectedAttempt&&!attemptIds.includes(selectedAttempt))return <p role="alert">所选执行尝试不存在或尚未读取，请选择当前执行查看。</p>;
  return (
    <>
      <label>执行尝试<select value={readingAttempt} onChange={event=>onSelectAttempt?.(Number(event.target.value))}>{attemptIds.map(attempt=><option key={attempt} value={attempt}>attempt #{attempt}{attempt === detail.snapshot.currentExecutionAttemptId ? "（当前）" : "（历史只读）"}</option>)}</select></label>
      {historical ? <><p>历史访问证据，只读；控制原执行请切回当前 attempt。</p><TeamPanel readOnly key={`${executionId}:${readingAttempt}`} runId={executionId} currentExecutionAttemptId={readingAttempt} phaseTitles={detail.snapshot.phases.map(phase=>phase.title)} visits={allVisits.filter(visit=>visit.executionAttemptId === readingAttempt)} busy={null} onAnswer={async()=>{throw new Error("历史 attempt 不能回答。");}} /></> : <>
      <ExecutionProgressCard
        snapshot={detail.snapshot}
        dynamicCount={dynamicCount}
        plannedTotal={detail.execution.config?.assignments.length}
        allVisits={allVisits}
      />
      <div className="execution-summary">
        <span>冻结 revision v{detail.execution.revision}</span>
        <code>{detail.execution.sourceHash}</code>
        <small>
          Runtime v{detail.execution.runtimeVersion} · 当前 attempt #
          {detail.snapshot.currentExecutionAttemptId}
        </small>
        {detail.execution.config && (
          <small>
            分配：{detail.execution.config.assignments.length} 名 Worker
            {detail.execution.config.ruleText
              ? ` · 规则“${detail.execution.config.ruleText}”${detail.execution.config.ruleDegraded ? "（解析失败，已退化为随机分配）" : ""}`
              : ""}
            {" · 回退到主控 Runtime "}
            {detail.execution.config.fallbackRuntimeId.slice(0, 8)}
          </small>
        )}
      </div>
      <div className="actions">
        {detail.controllable && detail.snapshot.status === "running" && (
          <Action
            label="暂停"
            icon="Ⅱ"
            tone="secondary"
            loading={busy === "execution:pause"}
            onClick={() => void onControl("pause")}
          />
        )}
        {detail.controllable && detail.snapshot.status === "paused" && (
          <Action
            label="恢复执行"
            icon="▶"
            tone="primary"
            loading={busy === "execution:recover"}
            onClick={() => void onControl("recover")}
          />
        )}
        {(detail.snapshot.status === "interrupted" || detail.snapshot.status === "cancelled" || (!detail.controllable && detail.snapshot.status !== "completed")) && (
          <Action
            label={detail.snapshot.status === "cancelled" ? "恢复已停止 Execution" : "恢复中断 Execution"}
            icon="↻"
            tone="primary"
            loading={busy === "execution:resume"}
            onClick={() => void onControl("resume")}
          />
        )}
        {detail.controllable && ["running", "pausing", "recovering", "paused"].includes(
          detail.snapshot.status,
        ) && (
          <Action
            label="停止 Execution"
            icon="■"
            tone="danger"
            loading={busy === "execution:stop"}
            onClick={() => void onControl("stop")}
          />
        )}
      </div>
      {!detail.controllable && detail.snapshot.status !== "completed" && detail.snapshot.status !== "interrupted" && detail.snapshot.status !== "cancelled" && (
        <div className="diagnostic">
          该 Execution 不在当前 Engine 的可控制生命周期内（Engine 已重启）；只能显式
          resume 创建新 attempt，pause/stop 与决策门回答都会被拒绝。
        </div>
      )}
      {detail.snapshot.diagnostic && (
        <div className="diagnostic">{detail.snapshot.diagnostic}</div>
      )}
      {detail.snapshot.gates
        .filter((gate) => gate.answer === null && detail.controllable && detail.snapshot.status === "running")
        .map((gate) => (
          <GateCard
            key={gate.gateId}
            gate={gate}
            busy={busy === `gate:${gate.gateId}`}
            onAnswer={(answer) => onAnswer(gate.gateId, answer)}
          />
        ))}
      <TeamPanel
        readOnly={!detail.controllable||terminal.has(detail.snapshot.status)}
        runId={detail.execution.executionId}
        currentExecutionAttemptId={detail.snapshot.currentExecutionAttemptId}
        phaseTitles={detail.snapshot.phases.map((phase) => phase.title)}
        visits={detail.snapshot.phaseVisits}
        fallbackPhases={detail.snapshot.phases}
        busy={busy}
        onAnswer={onAnswerBlock}
        loadAllVisits={loadAllVisits}
        waitingVisitId={detail.snapshot.gates.find(gate=>gate.answer === null && gate.executionAttemptId === detail.snapshot.currentExecutionAttemptId)?.phaseVisitId??undefined}
      />
      </>}
    </>
  );
}

function GateCard({
  gate,
  busy,
  onAnswer,
}: {
  gate: RunSnapshot["gates"][number];
  busy: boolean;
  onAnswer: (answer: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <article className="conversation-action execution-gate">
      <span>Execution 决策门 · {gate.gateId}</span>
      <p>{gate.question}</p>
      {gate.answerSchema ? (
        <SchemaForm
          schema={gate.answerSchema}
          busy={busy}
          submitLabel="提交答案"
          onSubmit={onAnswer}
        />
      ) : (
        <FreeJsonAnswer busy={busy} submitLabel="提交答案" onSubmit={onAnswer} />
      )}
    </article>
  );
}

/** 无 answerSchema 时的单行 JSON 输入；提交载荷与既有裸 JSON 行为一致（必须是 JSON 对象）。 */
function FreeJsonAnswer({
  busy,
  submitLabel,
  onSubmit,
}: {
  /** 提交中禁用。 */
  busy: boolean;
  /** 提交按钮文案。 */
  submitLabel: string;
  /** 提交回调。 */
  onSubmit: (answer: Record<string, unknown>) => Promise<void>;
}) {
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    try {
      const answer = JSON.parse(text) as unknown;
      if (!answer || Array.isArray(answer) || typeof answer !== "object")
        throw new Error("答案必须是 JSON 对象。 ");
      setError(null);
      await onSubmit(answer as Record<string, unknown>);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <div className="wf-free-answer">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        aria-label="答案 JSON"
      />
      <button disabled={busy} onClick={() => void submit()}>
        {busy ? "正在交付…" : submitLabel}
      </button>
      {error && <p className="answer-error">{error}</p>}
    </div>
  );
}


/** MCP 工具尾注组件已迁入 conversation/conversation-view.tsx（legacy 回合回落渲染）。 */

function conversationTitle(harness: HarnessSnapshot): string {
  return (
    harness.task?.title || harness.messages
      .find((message) => message.role === "user")
      ?.text.slice(0, 28) ||
    harness.cwd.split("/").filter(Boolean).at(-1) ||
    "新任务"
  );
}


function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{String(value).padStart(2, "0")}</strong>
    </div>
  );
}
function toRunListItem(response: RunResponse): RunListItem {
  const snapshot = response.snapshot;
  return {
    runId: response.runId,
    workflow: {
      name: snapshot.workflow.name,
      description: snapshot.workflow.description,
    },
    status: snapshot.status,
    cwd: snapshot.cwd,
    createdAt: snapshot.createdAt,
    endedAt: snapshot.endedAt,
    diagnostic: snapshot.diagnostic,
    hasBlockedAgent: snapshot.phases.some((phase) =>
      phase.agents.some((agent) => agent.status === "blocked"),
    ),
  };
}
function RunItem({
  run,
  active,
  onClick,
}: {
  run: RunListItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`run-item ${active ? "selected" : ""}`}
    >
      <span className={`dot ${run.status}`} />
      <div>
        <strong>{run.workflow.name}</strong>
        <small>
          {run.runId.slice(0, 8)} / {localeTime(run.createdAt)}
        </small>
      </div>
      <Status status={run.status} />
    </button>
  );
}

function RunDetail({
  run,
  busy,
  onControl,
  onAnswer,
}: {
  run: RunListItem;
  busy: string | null;
  onControl: (action: "pause" | "recover" | "stop" | "resume") => Promise<void>;
  onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
}) {
  const active = ["running", "pausing", "recovering"].includes(run.status);
  const [attempt, setAttempt] = useState<CurrentAttemptResponse | null>(null);
  const [history, setHistory] = useState<PhaseVisit[] | null>(null);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [attemptIds, setAttemptIds] = useState<number[] | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState<number | null>(null);
  useEffect(() => {
    let activeRequest = true;
    setAttempt(null);
    setHistory(null);
    setHistoryCursor(null);
    setAttemptIds(null);
    setHistoryAttempt(null);
    void api
      .currentAttempt(run.runId)
      .then((value) => {
        if (activeRequest) setAttempt(value);
      })
      .catch(() => {
        if (activeRequest) setAttempt(null);
      });
    return () => {
      activeRequest = false;
    };
  }, [run.runId, run.status]);
  // Desktop 不再有 Run SSE；活动 Run 只通过 Engine action 刷新权威当前尝试。
  // 这使 Worker 从 running → blocked/continued/completed 的状态变更能在详情中
  // 显示，而不会让 WebView 从 ACP 文本或本地计时推断任何业务状态。
  useEffect(() => {
    if (!active) return;
    let activeRequest = true;
    const reload = () => {
      void api.currentAttempt(run.runId).then(
        (value) => { if (activeRequest) setAttempt(value); },
        () => { if (activeRequest) setAttempt(null); },
      );
    };
    const timer = window.setInterval(reload, 1_000);
    return () => { activeRequest = false; window.clearInterval(timer); };
  }, [active, run.runId]);
  return (
    <>
      <div className="run-header">
        <div>
          <div className="eyebrow">当前工作流</div>
          <h1>{run.workflow.name}</h1>
          <p>{run.workflow.description}</p>
          <code>{run.runId}</code>
        </div>
        <div className="actions">
          {run.status === "running" && (
            <Action
              label="暂停"
              icon="Ⅱ"
              tone="secondary"
              loading={busy === "pause"}
              onClick={() => void onControl("pause")}
            />
          )}
          {run.status === "paused" && (
            <Action
              label="恢复执行"
              icon="▶"
              tone="primary"
              loading={busy === "recover"}
              onClick={() => void onControl("recover")}
            />
          )}
          {(run.status === "interrupted" || run.status === "cancelled") && (
            <Action
              label={run.status === "cancelled" ? "恢复已停止 Run" : "重新执行"}
              icon="↻"
              tone="primary"
              loading={busy === "resume"}
              onClick={() => void onControl("resume")}
            />
          )}
          {(active || run.status === "paused") && (
            <Action
              label="停止 Run"
              icon="■"
              tone="danger"
              loading={busy === "stop"}
              onClick={() => void onControl("stop")}
            />
          )}
        </div>
      </div>
      <div className="run-meta">
        <Status status={run.status} />
        <span>创建于 {localeTime(run.createdAt)}</span>
        <span>结束于 {localeTime(run.endedAt)}</span>
        <span className="path">{run.cwd}</span>
      </div>
      {run.diagnostic && <div className="diagnostic">{run.diagnostic}</div>}
      <div className="phase-list">
        {attempt ? (
          <>
            <div className="attempt-label">
              当前执行尝试 #{attempt.summary.executionAttemptId}
            </div>
            <TeamPanel
              runId={run.runId}
              currentExecutionAttemptId={attempt.summary.executionAttemptId}
              phaseTitles={attempt.summary.phases.map((phase) => phase.title)}
              busy={busy}
              onAnswer={onAnswer}
            />
            <section className="history-panel">
              <div>
                <strong>执行记录</strong>
                <span>
                  {includeEmpty
                    ? "包含没有创建 Agent 的阶段切换"
                    : "仅显示包含 Agent 的阶段轮次"}
                </span>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={includeEmpty}
                  onChange={(event) => {
                    setIncludeEmpty(event.target.checked);
                    setHistory(null);
                    setHistoryCursor(null);
                  }}
                />{" "}
                显示没有 Agent 的阶段切换
              </label>
              {attemptIds && (
                <label>
                  执行尝试{" "}
                  <select
                    value={historyAttempt ?? attempt.summary.executionAttemptId}
                    onChange={(event) => {
                      setHistoryAttempt(Number(event.target.value));
                      setHistory(null);
                      setHistoryCursor(null);
                    }}
                  >
                    {attemptIds.map((attemptId) => (
                      <option key={attemptId} value={attemptId}>
                        {attemptId === attempt.summary.executionAttemptId
                          ? `当前尝试 #${attemptId}`
                          : `历史尝试 #${attemptId}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                disabled={historyLoading}
                onClick={async () => {
                  setHistoryLoading(true);
                  try {
                    const attempts =
                      attemptIds ??
                      (await api.executionAttempts(run.runId))
                        .executionAttemptIds;
                    if (!attemptIds) setAttemptIds(attempts);
                    const selectedAttempt =
                      historyAttempt ?? attempt.summary.executionAttemptId;
                    const page = await api.phaseVisits(
                      run.runId,
                      history === null
                        ? { includeEmpty, attempt: selectedAttempt }
                        : {
                            cursor: historyCursor ?? undefined,
                            includeEmpty,
                            attempt: selectedAttempt,
                          },
                    );
                    setHistory((current) => [
                      ...(current ?? []),
                      ...page.items,
                    ]);
                    setHistoryCursor(page.nextCursor);
                  } finally {
                    setHistoryLoading(false);
                  }
                }}
              >
                {history === null
                  ? "查看执行记录"
                  : historyLoading
                    ? "正在加载…"
                    : historyCursor === null
                      ? "没有更多记录"
                      : "加载更早记录"}
              </button>
              {history && (
                <ol>
                  {history.map((item) => (
                    <li key={`${item.executionAttemptId}:${item.phaseVisitId}`}>
                      {item.title} · 第 {item.occurrence} 轮{" "}
                      <small>
                        {item.batches.reduce(
                          (count, batch) => count + batch.agents.length,
                          0,
                        )}{" "}
                        名 Agent
                      </small>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        ) : (
          <div className="empty-phase">正在读取当前执行摘要…</div>
        )}
      </div>
    </>
  );
}
function Status({ status }: { status: string }) {
  return <span className={`status ${status}`}>{statusLabel(status)}</span>;
}
function Action({
  label,
  icon,
  tone,
  loading,
  onClick,
}: {
  label: string;
  icon: string;
  tone: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`action ${tone}`} disabled={loading} onClick={onClick}>
      <span>{loading ? "…" : icon}</span>
      {label}
    </button>
  );
}
function statusLabel(status: string): string {
  return (
    (
      {
        queued: "排队中",
        running: "工作中",
        blocked: "需要协助",
        pausing: "暂停中",
        paused: "已暂停",
        recovering: "恢复中",
        completed: "已交付",
        cancelled: "已停止",
        interrupted: "已中断",
      } as Record<string, string>
    )[status] ?? status
  );
}
