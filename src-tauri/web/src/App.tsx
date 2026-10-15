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
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { ConversationView, shouldSubmitComposer as conversationShouldSubmitComposer } from "./conversation/conversation-view";
import { WorkflowRevisionCard } from "./conversation/revision-card";
import { TeamPanel } from "./execution/team-panel";
import { ExecutionProgressCard } from "./execution/progress-card";
import { SchemaForm } from "./forms/schema-form";
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

/** 原生文件选择器：只接受本地 .ts Workflow；用户取消返回 null。 */
async function pickWorkflowFile(): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Workflow", extensions: ["ts"] }],
  });
  return typeof picked === "string" ? picked : null;
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
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** "执行已有的 Workflow"的原生选择器预填：路径只读，cwd 默认当前项目目录。 */
  const [createRunPrefill, setCreateRunPrefill] = useState<{
    workflowPath: string;
    cwd: string;
  } | null>(null);
  const [harness, setHarness] = useState<HarnessSnapshot | null>(null);
  /** 新会话仅是浏览器草稿；首次发送前没有 Harness id、目录或 Journal。 */
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
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
  const [draftingRevision, setDraftingRevision] = useState(false);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    null,
  );
  const [executionDetail, setExecutionDetail] =
    useState<ExecutionResponse | null>(null);
  /** 当前详情 revision 的动态节点数；plan 不可用或为 0 时按 0 处理。 */
  const [executionDynamicCount, setExecutionDynamicCount] = useState(0);
  useEffect(() => {
    if (!harness || !executionDetail) return;
    let active = true;
    api
      .planExecution(harness.harnessRunId, executionDetail.execution.revision)
      .then((plan) => {
        if (active) setExecutionDynamicCount(plan.dynamicCount);
      })
      .catch(() => {
        if (active) setExecutionDynamicCount(0);
      });
    return () => {
      active = false;
    };
  }, [harness?.harnessRunId, executionDetail?.execution.revision]);
  /** 分配卡当前服务的已接受 revision；非 null 时展示两卡横滑流程。 */
  const [assignmentRevision, setAssignmentRevision] = useState<number | null>(
    null,
  );
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
    try {
      const [next, harnessList, projectList, runtimes] = await Promise.all([
        api.listRuns(),
        api.listHarnesses(),
        api.projects(),
        api.cliRuntimes(),
      ]);
      setRuns(next);
      setHarnesses(harnessList.harnesses);
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
      setHarness((current) => {
        if (!current) return current;
        return (
          harnessList.harnesses.find(
            (item) => item.harnessRunId === current.harnessRunId,
          ) ?? current
        );
      });
      setConnected(true);
      setError(null);
    } catch (cause) {
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
  useEffect(() => {
    if (!harness?.harnessRunId) return;
    let active = true;
    const refreshHarness = () => {
      void api
        .harness(harness.harnessRunId)
        .then((response) => {
          if (active) setHarness(response.harness);
        })
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
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
      void api
        .harness(harnessRunId)
        .then((response) => {
          if (disposed) return;
          setHarness(response.harness);
          setLastEventAt(Date.now());
        })
        .catch(() => {});
    };
    const unlisten = api.listenEngineEvents((envelope) => {
      if (disposed) return;
      if (envelope.frame.stream !== "harness") return;
      if (envelope.frame.harnessRunId !== harnessRunId) return;
      const decision = acceptEnvelope(tracker, envelope);
      if (decision === "skip") return;
      if (decision === "resync") {
        // generation 变化或漏帧：重读权威快照对齐（快照耐久包含该帧效果）。
        resync();
        return;
      }
      const event = envelope.frame.event;
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
    setBusy(action);
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
      setBusy(null);
    }
  }

  async function createRun(value: {
    workflowPath: string;
    cwd: string;
    input: Record<string, unknown>;
  }) {
    setBusy("create");
    try {
      const response = await api.createRun({
        ...value,
        clientRequestId: crypto.randomUUID(),
      });
      const item = toRunListItem(response);
      setRuns((current) => [
        item,
        ...current.filter((run) => run.runId !== item.runId),
      ]);
      setSelectedId(response.runId);
      setCreating(false);
      setCreateRunPrefill(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  /** 草稿窗口"执行已有的 Workflow"：原生选择器选中后预填并打开创建弹窗；取消无副作用。 */
  async function runExistingWorkflow() {
    try {
      const path = await pickWorkflowFile();
      if (!path) return;
      const project = projects.find(
        (item) => item.projectId === (draftProjectId ?? selectedProjectId),
      );
      setCreateRunPrefill({ workflowPath: path, cwd: project?.cwd ?? "" });
      setCreating(true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    setWorkflowPanelOpen(false);
    setAssignmentRevision(null);
    setError(null);
  }
  async function sendHarness() {
    if (!harnessText.trim()) return;
    try {
      if (harness) {
        await api.sendHarnessMessage(harness.harnessRunId, harnessText);
        updateHarnessText("");
        setHarness(
          await api
            .harness(harness.harnessRunId)
            .then((response) => response.harness),
        );
      } else {
        const projectId = draftProjectId ?? selectedProjectId;
        if (!projectId) return;
        const response = await api.startHarnessConversation(
          projectId,
          harnessText,
        );
        setHarness(response.harness);
        setHarnesses((current) => [response.harness, ...current]);
        updateHarnessText("");
        setDraftProjectId(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const selectExecution = useCallback(
    async (executionId: string) => {
      if (!harness) return;
      try {
        const detail = await api.execution(harness.harnessRunId, executionId);
        setSelectedExecutionId(executionId);
        setExecutionDetail(detail);
        setWorkflowPanelOpen(true);
      } catch (cause) {
        setError(executionLoadMessage(cause));
      }
    },
    [harness],
  );
  useEffect(() => {
    if (!harness || !selectedExecutionId) return;
    let active = true;
    const reload = () => {
      void api
        .execution(harness.harnessRunId, selectedExecutionId)
        .then((value) => {
          if (active) setExecutionDetail(value);
        })
        .catch((cause) => {
          if (active)
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
  }, [harness?.harnessRunId, selectedExecutionId]);
  async function createExecution(revision: number) {
    if (!harness) return;
    // 创建 Execution 必须经过分配卡：脚本字面量 cli/model 在受限 Execution 中不直接生效。
    setAssignmentRevision(revision);
  }
  async function finishAssignment(detail: ExecutionResponse) {
    if (!harness) return;
    setAssignmentRevision(null);
    setExecutionDetail(detail);
    setSelectedExecutionId(detail.execution.executionId);
    setWorkflowPanelOpen(true);
    setHarness((await api.harness(harness.harnessRunId)).harness);
    setError(null);
  }
  async function controlExecution(
    action: "pause" | "recover" | "stop" | "resume",
  ) {
    if (!harness || !executionDetail) return;
    setBusy(`execution:${action}`);
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
      setExecutionDetail(detail);
      setHarness((await api.harness(harness.harnessRunId)).harness);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main
      className={`agent-workbench theme-${theme} ${workflowPanelOpen ? "workflow-open" : ""}`}
    >
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
      <aside className="task-rail">
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
          ⊕ {selectedProjectId ? "新建会话" : "新建项目"}
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
        <nav className="task-list">
          {projects.map((project) => (
            <ProjectGroup
              key={project.projectId}
              project={project}
              harnesses={harnesses.filter((item) => item.projectId === project.projectId && (harnessView === "completed" ? item.status === "completed" : item.status !== "completed"))}
              activeHarnessId={harness?.harnessRunId ?? null}
              showNewSession={harnessView === "active"}
              onSelectProject={() => {
                setSelectedProjectId(project.projectId);
                setHarness(null);
                setDraftProjectId(null);
              }}
              onNewSession={() => beginHarnessDraft(project.projectId)}
              onSelectHarness={(item) => {
                setSelectedProjectId(project.projectId);
                setHarness(item);
                setDraftProjectId(null);
                setAssignmentRevision(null);
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
      <section className="conversation-pane">
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
            onRunWorkflow={() => void runExistingWorkflow()}
          />
        ) : (
          <HarnessConversation
            harness={harness}
            text={harnessText}
            onText={updateHarnessText}
            onSend={() => void sendHarness()}
            onAbort={() => void api.abortHarness(harness.harnessRunId)}
            onComplete={() => {
              setBusy("complete-harness");
              void api.completeHarness(harness.harnessRunId)
                .then((response) => {
                  setHarnesses((current) => current.map((item) => item.harnessRunId === response.harness.harnessRunId ? response.harness : item));
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
                .finally(() => setBusy(null));
            }}
            onOpenWorkflow={() => setWorkflowPanelOpen(true)}
            hasWorkflow={harness.executions.length > 0}
            onDraft={() => setDraftingRevision(true)}
            onAccept={async (revision) => {
              try {
                const response = await api.acceptWorkflowRevision(
                  harness.harnessRunId,
                  revision,
                );
                setHarness(response.harness);
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              }
            }}
            onReject={async (revision) => {
              const response = await api.rejectWorkflowRevision(
                harness.harnessRunId,
                revision,
              );
              setHarness(response.harness);
            }}
            onCreateExecution={(revision) => void createExecution(revision)}
            assignmentRevision={assignmentRevision}
            onAssignmentCancel={() => setAssignmentRevision(null)}
            onAssignmentCreated={(detail) => void finishAssignment(detail)}
            onSelectExecution={(executionId) =>
              void selectExecution(executionId)
            }
            onAnswerDecision={async (decisionId, answer) => {
              setBusy(`decision:${decisionId}`);
              try {
                const response = await api.answerHarnessDecision(
                  harness.harnessRunId,
                  decisionId,
                  answer,
                );
                setHarness(response.harness);
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              } finally {
                setBusy(null);
              }
            }}
            busy={busy}
            lastEventAt={lastEventAt}
          />
        )}
      </section>
      <aside
        className={`workflow-pane ${workflowPanelOpen ? "open" : "closed"}`}
      >
        <WorkflowPanelErrorBoundary
          onClose={() => setWorkflowPanelOpen(false)}
        >
          <header>
          <div>
            <span>
              {executionDetail
                ? `Execution · revision v${executionDetail.execution.revision}`
                : "Workflow 运行详情"}
            </span>
            <strong>
              {executionDetail?.snapshot.workflow.name ??
                selected?.workflow.name ??
                "尚未选择"}
            </strong>
          </div>
          <button
            onClick={() => setWorkflowPanelOpen(false)}
            aria-label="隐藏 Workflow 详情"
          >
            ×
          </button>
          </header>
          {executionDetail && harness ? (
          <div className="workflow-detail-scroll">
            <ExecutionDetail
              detail={executionDetail}
              busy={busy}
              dynamicCount={executionDynamicCount}
              harnessRunId={harness.harnessRunId}
              onControl={controlExecution}
              onAnswerBlock={async (blockId, answer) => {
                setBusy(`answer:${blockId}`);
                try {
                  await api.answer(blockId, answer);
                  const next = await api.execution(
                    harness.harnessRunId,
                    executionDetail.execution.executionId,
                  );
                  setExecutionDetail(next);
                } finally {
                  setBusy(null);
                }
              }}
              onAnswer={async (gateId, answer) => {
                setBusy(`gate:${gateId}`);
                try {
                  const next = await api.answerExecutionGate(
                    harness.harnessRunId,
                    executionDetail.execution.executionId,
                    gateId,
                    answer,
                  );
                  setExecutionDetail(next);
                } finally {
                  setBusy(null);
                }
              }}
            />
          </div>
          ) : !selected ? (
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
              busy={busy}
              onControl={control}
              onAnswer={async (blockId, answer) => {
                setBusy(`answer:${blockId}`);
                try {
                  await api.answer(blockId, answer);
                  await refresh();
                } finally {
                  setBusy(null);
                }
              }}
            />
          </div>
          )}
        </WorkflowPanelErrorBoundary>
      </aside>
      {!workflowPanelOpen && (
        <button
          className="workflow-peek"
          onClick={() => setWorkflowPanelOpen(true)}
        >
          <span>Workflow</span>
          <b>{runs.filter((run) => !terminal.has(run.status)).length}</b>
        </button>
      )}
      {creating && (
        <CreateRunModal
          busy={busy === "create"}
          initialWorkflowPath={createRunPrefill?.workflowPath ?? ""}
          initialCwd={createRunPrefill?.cwd ?? ""}
          onCreate={createRun}
          onClose={() => {
            setCreating(false);
            setCreateRunPrefill(null);
          }}
        />
      )}
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
      {draftingRevision && harness && (
        <WorkflowDraftModal
          onClose={() => setDraftingRevision(false)}
          onPropose={async (source) => {
            try {
              const response = await api.proposeWorkflowRevision(
                harness.harnessRunId,
                source,
              );
              setHarness(response.harness);
              setDraftingRevision(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
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
}: {
  item: HarnessSnapshot;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`harness-list-item ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className={`task-presence ${item.status}`} />
      <div>
        <strong>{conversationTitle(item)}</strong>
        <small>
          {item.status === "running"
            ? "进行中"
            : item.status === "interrupted"
              ? "已中断"
              : item.status === "completed"
                ? "已完成"
              : "待命"}{" "}
          · {localeTime(item.completedAt ?? item.createdAt)}
        </small>
      </div>
    </button>
  );
}
function ProjectGroup({
  project,
  harnesses,
  activeHarnessId,
  showNewSession,
  onSelectProject,
  onNewSession,
  onSelectHarness,
}: {
  project: HarnessProject;
  harnesses: HarnessSnapshot[];
  activeHarnessId: string | null;
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
            <HarnessListItem
              key={item.harnessRunId}
              item={item}
              active={item.harnessRunId === activeHarnessId}
              onClick={() => onSelectHarness(item)}
            />
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
  onRunWorkflow,
}: {
  project: HarnessProject | null;
  text: string;
  onText: (value: string) => void;
  onSend: () => void;
  /** 打开原生选择器执行已有 Workflow（.ts）。 */
  onRunWorkflow: () => void;
}) {
  const ready = project !== null;
  return (
    <div className="conversation draft-conversation">
      <header>
        <div>
          <span className="task-presence" />
          <div>
            <strong>新对话</strong>
            <small>{project?.title ?? "未选择项目"}</small>
          </div>
        </div>
        <div className="conversation-actions">
        </div>
      </header>
      <div className="conversation-scroll">
        <div className="conversation-intro">
          <span>新对话</span>
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
      <div className="draft-workflow-entry">
        <button
          type="button"
          className="button-secondary"
          disabled={!ready}
          onClick={onRunWorkflow}
        >
          执行已有的 Workflow（.ts）
        </button>
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
  onAccept,
  onReject,
  onCreateExecution,
  assignmentRevision,
  onAssignmentCancel,
  onAssignmentCreated,
  onSelectExecution,
  onAnswerDecision,
  onComplete,
  busy,
  lastEventAt,
}: {
  harness: HarnessSnapshot;
  text: string;
  onText: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onOpenWorkflow: () => void;
  hasWorkflow: boolean;
  onDraft: () => void;
  onAccept: (revision: number) => void;
  /** 拒绝草案；最新会话快照由调用方写回 state。 */
  onReject: (revision: number) => Promise<void>;
  onCreateExecution: (revision: number) => void;
  /** 分配卡当前展开的 revision；非 null 时内嵌在对应草案卡片下方。 */
  assignmentRevision: number | null;
  onAssignmentCancel: () => void;
  onAssignmentCreated: (detail: ExecutionResponse) => void;
  onSelectExecution: (executionId: string) => void;
  onAnswerDecision: (
    decisionId: string,
    answer: Record<string, unknown>,
  ) => Promise<void>;
  onComplete: () => void;
  busy: string | null;
  /** 最近一次条目事件到达时间（Date.now() 毫秒）；无事件时为 null。 */
  lastEventAt: number | null;
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
      onProposeWorkflow={onDraft}
      onOpenWorkflow={onOpenWorkflow}
      hasWorkflow={hasWorkflow}
      busy={busy}
      lastEventAt={lastEventAt}
    >
      {harness.workflowRevisions.map((revision) => (
          <WorkflowRevisionCard
            key={revision.revision}
            revision={revision}
            harness={harness}
            onAccept={onAccept}
            onReject={onReject}
            onCreateExecution={onCreateExecution}
            assignmentRevision={assignmentRevision}
            onAssignmentCancel={onAssignmentCancel}
            onAssignmentCreated={onAssignmentCreated}
          />
        ))}
        {harness.executions.map((execution) => (
          <ExecutionAction
            key={execution.executionId}
            execution={execution}
            onSelect={() => onSelectExecution(execution.executionId)}
          />
        ))}
        {harness.decisions
          .filter((decision) => decision.answer === null)
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

function ExecutionDetail({
  detail,
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
}) {
  const executionId = detail.execution.executionId;
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
  return (
    <>
      <ExecutionProgressCard
        snapshot={detail.snapshot}
        dynamicCount={dynamicCount}
        plannedTotal={detail.execution.config?.assignments.length}
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
        .filter((gate) => gate.answer === null)
        .map((gate) => (
          <GateCard
            key={gate.gateId}
            gate={gate}
            busy={busy === `gate:${gate.gateId}`}
            onAnswer={(answer) => onAnswer(gate.gateId, answer)}
          />
        ))}
      <TeamPanel
        runId={detail.execution.executionId}
        currentExecutionAttemptId={detail.snapshot.currentExecutionAttemptId}
        phaseTitles={detail.snapshot.phases.map((phase) => phase.title)}
        visits={detail.snapshot.phaseVisits}
        fallbackPhases={detail.snapshot.phases}
        busy={busy}
        onAnswer={onAnswerBlock}
        loadAllVisits={loadAllVisits}
      />
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

function WorkflowDraftModal({
  onClose,
  onPropose,
}: {
  onClose: () => void;
  onPropose: (source: string) => void;
}) {
  const [source, setSource] = useState(
    'const meta = { name: "draft-workflow", description: "待确认的 Workflow 草案", phases: [{ title: "计划" }] };\n\nasync function run(args) {\n  phase("计划");\n  return agent("请完成已确认的任务", { id: "plan", cli: "codex" });\n}',
  );
  return (
    <div className="connection-backdrop" onMouseDown={onClose}>
      <section
        className="connection-panel workflow-draft"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-draft-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      >
        <header>
          <div>
            <span>Workflow 提案</span>
            <strong id="workflow-draft-title">冻结前的草案</strong>
          </div>
          <button aria-label="关闭 Workflow 草案" onClick={onClose}>×</button>
        </header>
        <p>
          保存后只产生不可变 hash 草案；接受动作也不会创建 Worker
          或执行代码。创建 Execution 前请使用受限语法：顶层仅 const meta 与
          async function run(args)，不得 export/import 或访问 Bun/Node。
        </p>
        <textarea
          aria-label="Workflow 草案源码"
          autoFocus
          value={source}
          onChange={(event) => setSource(event.target.value)}
          spellCheck={false}
        />
        <div>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onPropose(source)}>
            保存草案
          </button>
        </div>
      </section>
    </div>
  );
}

/** MCP 工具尾注组件已迁入 conversation/conversation-view.tsx（legacy 回合回落渲染）。 */

function conversationTitle(harness: HarnessSnapshot): string {
  return (
    harness.messages
      .find((message) => message.role === "user")
      ?.text.slice(0, 28) ||
    harness.cwd.split("/").filter(Boolean).at(-1) ||
    "新任务"
  );
}

function CreateRunModal({
  busy,
  initialWorkflowPath,
  initialCwd,
  onCreate,
  onClose,
}: {
  busy: boolean;
  /** 原生选择器选中的 Workflow 路径（只读展示）。 */
  initialWorkflowPath: string;
  /** 默认项目目录（可编辑）。 */
  initialCwd: string;
  onCreate: (value: {
    workflowPath: string;
    cwd: string;
    input: Record<string, unknown>;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [workflowPath, setWorkflowPath] = useState(initialWorkflowPath);
  const [cwd, setCwd] = useState(initialCwd);
  const [input, setInput] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  async function pickAgain() {
    try {
      const picked = await pickWorkflowFile();
      if (picked) setWorkflowPath(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error("输入必须是 JSON 对象。 ");
      if (!workflowPath.trim() || !cwd.trim())
        throw new Error("请先选择 Workflow 文件并填写项目目录。 ");
      setError(null);
      await onCreate({
        workflowPath: workflowPath.trim(),
        cwd: cwd.trim(),
        input: parsed as Record<string, unknown>,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <div className="create-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="create-run"
        aria-label="新建 Run"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="create-head">
          <div>
            <span>新建任务</span>
            <strong>从本地 workflow 启动</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="create-field">
          <span>Workflow 文件</span>
          {workflowPath ? (
            <div className="create-picked-path">
              <code>{workflowPath}</code>
              <button type="button" onClick={() => void pickAgain()}>
                重新选择
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => void pickAgain()}>
              选择本地 .ts 文件…
            </button>
          )}
        </div>
        <label>
          项目目录 cwd
          <input
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="/绝对路径/项目目录"
          />
        </label>
        <label>
          输入 JSON
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
          />
        </label>
        {error && <div className="create-error">{error}</div>}
        <div className="create-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !workflowPath.trim()}
            type="submit"
          >
            {busy ? "正在创建…" : "创建 Run"}
          </button>
        </div>
      </form>
    </div>
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
