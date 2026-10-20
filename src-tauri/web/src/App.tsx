import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { TaskTitleEditor } from "./task-title-editor";
import { ProjectCreateDialog } from "./project-create-dialog";
import { useProjectExpanded } from "./project-navigation";
import { userFacingText } from "./user-facing-text";
import {
  RAIL_WIDTH_DEFAULT,
  loadRailWidth,
  persistRailWidth,
  railWidthFromDrag,
} from "./rail-width";
import { summaryBodyStartedAt } from "./conversation/harness-event-merge";
import { Markdown as MessageBody } from "./conversation/markdown";
import {
  ConversationView,
  shouldSubmitComposer as conversationShouldSubmitComposer,
} from "./conversation/conversation-view";
import { AutoGrowTextarea } from "./conversation/auto-grow-textarea";
import { WorkflowRevisionCard } from "./conversation/revision-card";
import {
  WorkflowExecutionSummary,
  proposalTitle,
} from "./conversation/workflow-summary";
import { AbandonedPlan } from "./conversation/abandoned-plan";
import {
  hasActiveExecutionQuestions,
  interruptedSummaryObligations,
  summaryWorkLabel,
  TaskActivity,
} from "./conversation/task-activity";
import { PreviousRecords } from "./execution/previous-records";
import { planUpdateLabel } from "./conversation/plan-updates";
import { WorkflowVersions } from "./conversation/workflow-versions";
import {
  workflowCells,
  editableRevision,
  readingAttempt,
  type WorkbenchRoute,
} from "./workbench-navigation";
import {
  routeMatchesTask,
  newerTaskSnapshot,
  OperationTracker,
  RequestFence,
  UnreadTracker,
} from "./workbench-state";
import { ViewCache } from "./workbench-state";
const detailPositions = new ViewCache<number>();
import { TeamPanel } from "./execution/team-panel";
import { ExecutionProgressCard } from "./execution/progress-card";
import { ExecutionDiagnostics } from "./execution/execution-diagnostics";
import { SchemaForm } from "./forms/schema-form";
import { TemplatePicker } from "./template-picker";
import { LocalWorkflowPreview } from "./local-workflow-preview";
import { PersistedDetails } from "./persisted-details";
import {
  acceptEnvelope,
  applyHarnessEventToSnapshot,
  createStreamTracker,
} from "./conversation/harness-event-merge";
import type {
  CliRuntime,
  CliRuntimeListResponse,
  DesktopStatusResponse,
  ExecutionResponse,
  HarnessDecision,
  HarnessProject,
  HarnessSnapshot,
  PhaseVisit,
  RunSnapshot,
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
  const [harnesses, setHarnesses] = useState<HarnessSnapshot[]>([]);
  const [projects, setProjects] = useState<HarnessProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyOperations, setBusyOperations] = useState<Record<string, string>>(
    {},
  );
  const operationTracker = useRef(new OperationTracker());
  const beginBusy = (owner: string, action: string) => {
    const release = operationTracker.current.begin(owner, action);
    setBusyOperations((current) => ({ ...current, [owner]: action }));
    return () => {
      if (!release()) return;
      setBusyOperations((current) => {
        const next = { ...current };
        delete next[owner];
        return next;
      });
    };
  };
  const [harness, setHarness] = useState<HarnessSnapshot | null>(null);
  const [archiveConfirmation, setArchiveConfirmation] = useState<{
    harnessRunId: string;
    count: number;
  } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<HarnessSnapshot | null>(
    null,
  );
  /** 普通归档不确认、不放弃总结或候选；后端门禁仍是权威。 */
  async function archiveTask(target: HarnessSnapshot) {
    if (
      target.impactSummaries?.some(
        (item) => !item.supersededBy && item.status !== "completed",
      )
    ) {
      setArchiveTarget(target);
      return;
    }
    const id = target.harnessRunId,
      finishBusy = beginBusy(`task:${id}`, "complete-harness");
    try {
      await taskMutation(id, () => api.completeHarness(id));
      if (harnessRef.current?.harnessRunId !== id) return;
      setHarness(null);
      setDraftProjectId(target.projectId);
      setSelectedProjectId(target.projectId);
      setRoute({ kind: "conversation" });
      setHarnessText("");
      setWorkflowPanelOpen(false);
      setHarnessView("active");
    } catch (cause) {
      setError(String(cause));
    } finally {
      finishBusy();
    }
  }
  useEffect(() => setArchiveConfirmation(null), [harness?.harnessRunId]);
  /** 新会话仅是浏览器草稿；首次发送前没有 Harness id、目录或 Journal。 */
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useProjectExpanded("section");
  const [route, setRoute] = useState<WorkbenchRoute>({ kind: "conversation" });
  const [navOpen, setNavOpen] = useState(false);
  const navigationButton = useRef<HTMLButtonElement | null>(null);
  const navigationPanel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!navOpen) return;
    navigationPanel.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setNavOpen(false);
        navigationButton.current?.focus();
      }
      if (
        event.key === "Tab" &&
        window.matchMedia("(max-width:900px)").matches
      ) {
        const controls = [
          ...(navigationPanel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
          ) ?? []),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [navOpen]);
  const [templatePicker, setTemplatePicker] = useState(false);
  const [localPreview, setLocalPreview] = useState(false);
  const [adjustFocus, setAdjustFocus] = useState(0);
  const [adjustContext, setAdjustContext] = useState<{
    taskId: string;
    revision: number;
    abandoned: boolean;
  } | null>(null);
  useEffect(() => {
    if (adjustFocus && route.kind === "conversation") {
      const frame = requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>(
            ".conversation-composer textarea:not(:disabled)",
          )
          ?.focus(),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [adjustFocus, route.kind]);
  const [localRevision, setLocalRevision] = useState<null | {
    harnessRunId: string;
    baseRevision: number;
    path: string;
    input: Record<string, unknown>;
  }>(null);
  const createRequest = useRef<string | null>(null);
  const sending = useRef(false);
  /** 已提交但尚未在快照中确认的消息身份；用于重试幂等，文本变化即作废。 */
  const pendingMessage = useRef<{
    id: string;
    text: string;
    owner: string;
    attachmentIds: string;
  } | null>(null);
  /** 待发送图片按任务/项目草稿隔离；切换保留，成功只清除本次已接受的图片。 */
  const attachmentOwner =
    harness?.harnessRunId ??
    `draft:${draftProjectId ?? selectedProjectId ?? "none"}`;
  const [attachmentDrafts, setAttachmentDrafts] = useState<
    Map<string, import("./types").StagedAttachment[]>
  >(() => new Map());
  const pendingAttachments = attachmentDrafts.get(attachmentOwner) ?? [];
  const setPendingAttachments = (
    update:
      | import("./types").StagedAttachment[]
      | ((
          current: import("./types").StagedAttachment[],
        ) => import("./types").StagedAttachment[]),
  ) => {
    setAttachmentDrafts((current) => {
      const next = new Map(current);
      const items =
        typeof update === "function"
          ? update(current.get(attachmentOwner) ?? [])
          : update;
      if (items.length) next.set(attachmentOwner, items);
      else next.delete(attachmentOwner);
      return next;
    });
  };
  const stagingAttachments = useRef(false);
  const [stagingOwner, setStagingOwner] = useState<string | null>(null);
  const [attachmentErrors, setAttachmentErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const attachmentError = attachmentErrors.get(attachmentOwner) ?? null;
  const setAttachmentError = (message: string | null) =>
    setAttachmentErrors((current) => {
      const next = new Map(current);
      if (message) next.set(attachmentOwner, message);
      else next.delete(attachmentOwner);
      return next;
    });
  const attachmentDraftsRef = useRef(attachmentDrafts);
  attachmentDraftsRef.current = attachmentDrafts;
  // 左侧任务/对话记录栏宽度：窗口层级耐久偏好；拖动过程平滑更新，落指针后才保存。
  const [railWidth, setRailWidth] = useState(() =>
    typeof window === "undefined"
      ? RAIL_WIDTH_DEFAULT
      : loadRailWidth(window.localStorage),
  );
  const railWidthRef = useRef(railWidth);
  railWidthRef.current = railWidth;
  const [railDragging, setRailDragging] = useState(false);
  const startRailDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidthRef.current;
    setRailDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* window 监听仍完整工作。 */
    }
    const onMove = (move: PointerEvent) => {
      setRailWidth(railWidthFromDrag(startWidth, startX, move.clientX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      setRailDragging(false);
      persistRailWidth(railWidthRef.current, window.localStorage);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  };
  async function addAttachments() {
    if (stagingAttachments.current) return;
    stagingAttachments.current = true;
    const owner = attachmentOwner;
    setStagingOwner(owner);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const existing = attachmentDraftsRef.current.get(owner)?.length ?? 0;
      if (existing + paths.length > 5) {
        setAttachmentError(
          `一条消息最多添加 5 张图片，当前已有 ${existing} 张，本次选择 ${paths.length} 张。请减少选择或先移除图片。`,
        );
        return;
      }
      const failures: string[] = [];
      for (const path of paths) {
        try {
          const staged = await api.stageAttachment(path);
          setPendingAttachments((current) =>
            current.some((item) => item.stagedId === staged.stagedId)
              ? current
              : [...current, staged],
          );
        } catch (cause) {
          failures.push(
            `${path.split("/").pop() ?? path}：${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      setAttachmentError(
        failures.length ? `部分附件未接受：${failures.join("；")}` : null,
      );
    } catch (cause) {
      setAttachmentError(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      stagingAttachments.current = false;
      setStagingOwner(null);
    }
  }
  const routeRef = useRef(route);
  routeRef.current = route;
  const harnessRef = useRef(harness);
  harnessRef.current = harness;
  const detailToken = useRef(0);
  const requestFence = useRef(new RequestFence());
  const unreadTracker = useRef(new UnreadTracker());
  const prepareRevisionDraft = (
    task: HarnessSnapshot,
    revision: import("./types").WorkflowRevision,
    abandoned: boolean,
  ) => {
    setAdjustContext({
      taskId: task.harnessRunId,
      revision: revision.revision,
      abandoned,
    });
    if (!harnessText.trim())
      updateHarnessText(
        abandoned ? "原方案已放弃，我希望新方案……" : "我希望调整……",
      );
    setRoute({ kind: "conversation" });
    setAdjustFocus((value) => value + 1);
  };
  const [, refreshRead] = useState(0);
  const markRead = useCallback((owner: string, ids: string[]) => {
    const task = harnessRef.current;
    if (
      !task ||
      task.harnessRunId !== owner ||
      routeRef.current.kind !== "conversation"
    )
      return;
    unreadTracker.current.mark(owner, ids);
    refreshRead((value) => value + 1);
  }, []);
  const unreadCounts = new Map(
    harnesses.map((task) => [
      task.harnessRunId,
      unreadTracker.current.count(
        harness?.harnessRunId === task.harnessRunId
          ? newerTaskSnapshot(task, harness)
          : task,
        false,
      ),
    ]),
  );
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
    if (workflowLocations.current.size > 64)
      workflowLocations.current.delete(
        workflowLocations.current.keys().next().value!,
      );
  }, [route, harness?.harnessRunId, draftProjectId]);
  const workflowPanelOpen = route.kind === "workflow";
  const workflowTitle = useRef<HTMLElement>(null);
  const workflowReturn = useRef<{
    taskId: string | null;
    button: HTMLElement;
  } | null>(null);
  const wasWorkflowOpen = useRef(false);
  useEffect(() => {
    if (workflowPanelOpen && !wasWorkflowOpen.current)
      workflowTitle.current?.focus({ preventScroll: true });
    else if (!workflowPanelOpen && wasWorkflowOpen.current) {
      const prior = workflowReturn.current;
      if (document.querySelector(".history-sidebar")) {
        wasWorkflowOpen.current = workflowPanelOpen;
        return;
      }
      if (prior?.taskId === (harness?.harnessRunId ?? null)) {
        const target = prior.button.isConnected
          ? prior.button
          : document.querySelector<HTMLElement>(".task-current-actions button");
        target?.focus({ preventScroll: true });
      }
    }
    wasWorkflowOpen.current = workflowPanelOpen;
  }, [workflowPanelOpen, harness?.harnessRunId]);
  const centralScroll = useRef<HTMLElement | null>(null);
  const pageKey =
    route.kind === "workflow"
      ? `${route.taskId}:${route.cardId}:${route.revision}:${route.section}:${route.executionId ?? ""}:${route.attempt ?? "current"}`
      : "conversation";
  useEffect(() => {
    const el = centralScroll.current;
    if (!el || route.kind !== "workflow") return;
    el.scrollTop = detailPositions.get(pageKey) ?? 0;
    return () => {
      detailPositions.set(pageKey, el.scrollTop);
    };
  }, [pageKey]);
  function setWorkflowPanelOpen(open: boolean) {
    if (!open) setRoute({ kind: "conversation" });
  }
  function openWorkflow(
    task: HarnessSnapshot,
    revision: import("./types").WorkflowRevision,
    section?: "plan" | "execution" | "results",
    executionId?: string,
  ) {
    setTemplatePicker(false);
    setHarness(task);
    setDraftProjectId(null);
    const cardId = revision.cardId ?? `legacy:${revision.revision}`;
    const saved =
      harnessRef.current?.harnessRunId === task.harnessRunId
        ? workflowLocations.current.get(`${task.harnessRunId}:${cardId}`)
        : undefined;
    const linked = task.executions.find(
      (item) => item.revision === revision.revision,
    );
    const next: WorkbenchRoute =
      !section &&
      saved?.kind === "workflow" &&
      task.workflowRevisions.some((item) => item.revision === saved.revision)
        ? saved
        : {
            kind: "workflow",
            taskId: task.harnessRunId,
            cardId,
            revision: revision.revision,
            section: section ?? (linked ? "execution" : "plan"),
            executionId: executionId ?? linked?.executionId,
          };
    setRoute(next);
    setNavOpen(false);
    setSelectedExecutionId(next.executionId ?? null);
    setExecutionDetail(null);
  }
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
      if (draftCacheRef.current.size > 64)
        draftCacheRef.current.delete(
          draftCacheRef.current.keys().next().value!,
        );
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
    setExecutionDynamicCount(executionDetail.dynamicCount ?? 0);
  }, [harness?.harnessRunId, executionDetail?.execution.revision]);
  /** 分配卡当前服务的已接受 revision；非 null 时展示两卡横滑流程。 */
  const [theme, setTheme] = useState<ColorTheme>(readColorTheme);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [harnessView, setHarnessView] = useState<"active" | "completed">(
    "active",
  );

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
      try {
        const action = await invoke<string | null>("take_menu_action");
        if (active) {
          if (action === "shutdown") setExitConfirmOpen(true);
          else if (action === "settings") setSettingsOpen(true);
        }
      } catch {
        /* 菜单栏是辅助 UI；轮询失败绝不改变工作台或 Engine 状态。 */
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const refresh = useCallback(async () => {
    const valid = requestFence.current.begin("task-list");
    try {
      const [harnessList, projectList, runtimes] = await Promise.all([
        api.listHarnesses(),
        api.projects(),
        api.cliRuntimes(),
      ]);
      if (!valid()) return;
      setHarnesses((current) =>
        harnessList.harnesses.map((next) => {
          const old = current.find(
            (item) => item.harnessRunId === next.harnessRunId,
          );
          return old ? newerTaskSnapshot(old, next) : next;
        }),
      );
      setProjects(projectList.projects);
      setRuntimeState(runtimes);
      setSelectedProjectId((current) =>
        current &&
        projectList.projects.some((project) => project.projectId === current)
          ? current
          : (projectList.projects[0]?.projectId ?? null),
      );
      // Desktop 没有 HTTP/SSE 控制面；轮询只读取 Engine 的耐久完整快照。未完成
      // reasoning 与 delta 不进入 Journal，因此页面不会把半条模型输出误当结果。
      setConnected(true);
      setError(null);
    } catch (cause) {
      if (!valid()) return;
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
              ? `${status.activeHarnesses} 个 Wave Flow 会话进行中`
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

  const taskBusy = harness
    ? (busyOperations[`task:${harness.harnessRunId}`] ?? null)
    : null;
  const executionBusy = selectedExecutionId
    ? (busyOperations[`execution:${selectedExecutionId}`] ?? null)
    : null;
  useEffect(() => {
    if (!harness?.harnessRunId) return;
    let active = true;
    let request = 0;
    const refreshHarness = () => {
      const token = ++request;
      const valid = requestFence.current.begin(`task:${harness.harnessRunId}`);
      void api
        .harness(harness.harnessRunId)
        .then((response) => {
          if (active && token === request && valid())
            setHarness((current) =>
              current ? newerTaskSnapshot(current, response.harness) : current,
            );
        })
        .catch((cause) => {
          if (active && token === request && valid())
            setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    refreshHarness();
    // 事件流为主通道；4 秒轮询只是断帧兜底。
    const timer = window.setInterval(refreshHarness, 4_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [harness?.harnessRunId]);

  /** Engine 事件驱动会话增量更新；条目先耐久后发布，事件与快照同源。 */
  useEffect(() => {
    const harnessRunId = harness?.harnessRunId;
    if (!harnessRunId) return;
    const tracker = createStreamTracker();
    let disposed = false;
    setLastEventAt(null);
    const resync = () => {
      const valid = requestFence.current.begin(`task:${harnessRunId}`);
      void api
        .harness(harnessRunId)
        .then((response) => {
          if (disposed || !valid()) return;
          setHarness((current) =>
            current ? newerTaskSnapshot(current, response.harness) : current,
          );
          setLastEventAt(Date.now());
        })
        .catch(() => {});
    };
    const unlisten = api.listenEngineEvents((envelope) => {
      if (disposed) return;
      if (envelope.frame.stream !== "harness") return;
      if (envelope.frame.harnessRunId !== harnessRunId) return;
      if (tracker.generation !== -1 && tracker.generation < envelope.generation)
        requestFence.current.advance();
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
        event.type === "execution_changed" ||
        event.type === "queue_changed"
        || event.type === "title_changed"
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

  function beginHarnessDraft(projectId = selectedProjectId) {
    setHarnessView("active");
    if (!projectId) return;
    setSelectedProjectId(projectId);
    setDraftProjectId(projectId);
    setHarness(null);
    setHarnessText("");
    createRequest.current = null;
    setWorkflowPanelOpen(false);
    setError(null);
  }
  async function sendHarness(immediate = false) {
    if (
      !harnessText.trim() ||
      sending.current ||
      stagingOwner === attachmentOwner
    )
      return;
    sending.current = true;
    const owner = harness?.harnessRunId;
    const text = harnessText;
    const context = adjustContext?.taskId === owner ? adjustContext : null;
    const message = context
      ? `${context.abandoned ? "第 " + context.revision + " 版方案已放弃，请按以下要求重新设计" : "请调整工作流第 " + context.revision + " 版"}：\n${text}`
      : text;
    const pageToken = navigationToken.current;
    try {
      if (harness) {
        // 同一份未确认草稿重试复用同一消息 id：Engine 幂等去重，重复点击/重试不产生第二条。
        const attachmentIds = pendingAttachments
          .map((item) => item.stagedId)
          .join(",");
        if (
          !pendingMessage.current ||
          pendingMessage.current.text !== message ||
          pendingMessage.current.owner !== owner ||
          pendingMessage.current.attachmentIds !== attachmentIds
        )
          pendingMessage.current = {
            id: crypto.randomUUID(),
            text: message,
            owner: owner!,
            attachmentIds,
          };
        const clientMessageId = pendingMessage.current.id;
        const stagedIds = pendingAttachments.map((item) => item.stagedId);
        const sent = await api.sendHarnessMessage(
          harness.harnessRunId,
          message,
          {
            clientMessageId,
            ...(immediate ? { immediate: true } : {}),
            ...(stagedIds.length ? { stagedAttachmentIds: stagedIds } : {}),
          },
        );
        if (
          sent.harness.messages.some((item) => item.id === clientMessageId) ||
          sent.harness.messageQueue.some(
            (item) => item.message.id === clientMessageId,
          )
        ) {
          if (pendingMessage.current?.id === clientMessageId)
            pendingMessage.current = null;
          setPendingAttachments((current) =>
            current.filter((item) => !stagedIds.includes(item.stagedId)),
          );
        }
        if (context) setAdjustContext(null);
        if (draftCacheRef.current.get(owner!) === text)
          draftCacheRef.current.set(owner!, "");
        const next = (await api.harness(owner!)).harness;
        if (harnessRef.current?.harnessRunId === owner) {
          setHarness((current) =>
            current ? newerTaskSnapshot(current, next) : current,
          );
          setHarnessText(draftCacheRef.current.get(owner!) ?? "");
        }
      } else {
        const projectId = draftProjectId ?? selectedProjectId;
        if (!projectId) return;
        const stagedIds = pendingAttachments.map((item) => item.stagedId);
        const response = await api.startConversationWithAttachments(
          projectId,
          text,
          createRequest.current ??
            (createRequest.current = crypto.randomUUID()),
          undefined,
          stagedIds,
        );
        setHarnesses((current) => [
          response.harness,
          ...current.filter(
            (item) => item.harnessRunId !== response.harness.harnessRunId,
          ),
        ]);
        if (
          response.harness.messages.some(
            (item) => item.role === "user" && item.attachments?.length,
          )
        )
          setPendingAttachments((current) =>
            current.filter((item) => !stagedIds.includes(item.stagedId)),
          );
        if (navigationToken.current === pageToken && !harnessRef.current) {
          // 创建失败保留原图预览到原任务，后续显式重试使用manifest冻结的原身份。
          setAttachmentDrafts((current) => {
            const next = new Map(current),
              remaining = next.get(attachmentOwner);
            if (remaining?.length)
              next.set(response.harness.harnessRunId, remaining);
            next.delete(attachmentOwner);
            return next;
          });
          setHarness(response.harness);
          updateHarnessText("");
          setDraftProjectId(null);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sending.current = false;
    }
  }
  const selectExecution = useCallback(
    async (executionId: string, attempt?: number) => {
      if (!harness) return;
      const execution = harness.executions.find(
        (item) => item.executionId === executionId,
      );
      const revision = harness.workflowRevisions.find(
        (item) => item.revision === execution?.revision,
      );
      if (revision) {
        openWorkflow(harness, revision, "execution", executionId);
        if (attempt)
          setRoute({
            kind: "workflow",
            taskId: harness.harnessRunId,
            cardId: revision.cardId ?? `legacy:${revision.revision}`,
            revision: revision.revision,
            section: "execution",
            executionId,
            attempt,
          });
      }
    },
    [harness],
  );
  useEffect(() => {
    if (
      !harness ||
      !selectedExecutionId ||
      route.kind !== "workflow" ||
      route.taskId !== harness.harnessRunId
    )
      return;
    let active = true;
    setExecutionDetail(null);
    const owner = harness.harnessRunId;
    const reload = () => {
      const token = ++detailToken.current;
      const valid = requestFence.current.begin(
        `execution:${owner}:${selectedExecutionId}`,
      );
      void api
        .execution(harness.harnessRunId, selectedExecutionId)
        .then((value) => {
          if (
            active &&
            valid() &&
            token === detailToken.current &&
            harnessRef.current?.harnessRunId === owner
          )
            setExecutionDetail(value);
        })
        .catch((cause) => {
          if (active && valid()) setError(executionLoadMessage(cause));
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
    const executionRevision = next.workflowRevisions.find(
      (item) => item.revision === detail.execution.revision,
    );
    if (
      harnessRef.current?.harnessRunId !== owner ||
      routeRef.current.kind !== "workflow" ||
      executionRevision?.cardId !== routeRef.current.cardId
    )
      return;
    setHarness((current) =>
      current ? newerTaskSnapshot(current, next) : current,
    );
    setExecutionDetail(detail);
    setSelectedExecutionId(detail.execution.executionId);
    setRoute({
      ...routeRef.current,
      revision: detail.execution.revision,
      section: "execution",
      executionId: detail.execution.executionId,
      attempt: undefined,
    });
    setError(null);
  }
  /** 所有 Task mutation 回包共享同资源门禁；后台动作完成不改变当前导航。 */
  async function taskMutation(
    owner: string,
    operation: () => Promise<{ harness: HarnessSnapshot }>,
  ) {
    const valid = requestFence.current.begin(`task:${owner}`);
    const response = await operation();
    if (valid())
      setHarnesses((current) =>
        current.map((item) =>
          item.harnessRunId === owner ? response.harness : item,
        ),
      );
    if (valid() && harnessRef.current?.harnessRunId === owner)
      setHarness((current) =>
        current ? newerTaskSnapshot(current, response.harness) : current,
      );
    return response;
  }
  async function controlExecution(
    action: "pause" | "recover" | "stop" | "resume",
  ) {
    if (!harness || !executionDetail) return;
    const valid = requestFence.current.begin(
      `execution:${harness.harnessRunId}:${executionDetail.execution.executionId}`,
    );
    const finishBusy = beginBusy(
      `execution:${executionDetail.execution.executionId}`,
      `execution:${action}`,
    );
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
      if (
        valid() &&
        harnessRef.current?.harnessRunId === owner &&
        routeRef.current.kind === "workflow" &&
        routeRef.current.executionId === detail.execution.executionId
      )
        setExecutionDetail(detail);
      const next = (await api.harness(owner)).harness;
      if (harnessRef.current?.harnessRunId === owner)
        setHarness((current) =>
          current ? newerTaskSnapshot(current, next) : current,
        );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      finishBusy();
    }
  }

  return (
    <main
      className={`agent-workbench theme-${theme} ${navOpen ? "nav-open" : ""} ${"__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform) ? "native-titlebar" : ""}`}
      style={{ "--wf-rail-width": `${railWidth}px` } as CSSProperties}
    >
      {"__TAURI_INTERNALS__" in window && /Mac/.test(navigator.platform) && (
        <div className="desktop-titlebar" data-tauri-drag-region="deep">
          <div
            title={
              harness
                ? `${harness.cwd.split("/").filter(Boolean).at(-1)} / ${conversationTitle(harness)}`
                : "Wave Flow"
            }
          >
            {harness ? (
              <>
                <span>{harness.cwd.split("/").filter(Boolean).at(-1)}</span>
                <span className="title-divider">/</span>
                <strong>{conversationTitle(harness)}</strong>
              </>
            ) : (
              <strong>Wave Flow</strong>
            )}
          </div>
        </div>
      )}
      <button
        ref={navigationButton}
        className="navigation-toggle"
        aria-label={navOpen ? "关闭任务导航" : "打开任务导航"}
        aria-expanded={navOpen}
        aria-controls="task-navigation"
        onClick={() => setNavOpen((value) => !value)}
      >
        ☰
      </button>
      {navOpen && (
        <button
          className="navigation-scrim"
          aria-label="关闭任务导航"
          onClick={() => {
            setNavOpen(false);
            navigationButton.current?.focus();
          }}
        />
      )}
      {error && (
        <div className="toast-layer" role="status" aria-live="polite">
          <div className="notice">
            <span>!</span>
            <div>{userFacingText(error)}</div>
            <button aria-label="关闭错误提示" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        </div>
      )}
      {archiveTarget && (
        <ArchiveTaskConfirmation
          task={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onConfirm={() => {
            const target = archiveTarget,
              id = target.harnessRunId;
            const unfinished = target.impactSummaries?.some(
              (item) => !item.supersededBy && item.status !== "completed",
            );
            const finishBusy = beginBusy(`task:${id}`, "complete-harness");
            setArchiveTarget(null);
            void taskMutation(id, () =>
              unfinished
                ? api.archiveAbandoningSummaries(id)
                : api.completeHarness(id),
            )
              .then(() => {
                if (harnessRef.current?.harnessRunId !== id) return;
                setHarness(null);
                setDraftProjectId(target.projectId);
                setSelectedProjectId(target.projectId);
                setRoute({ kind: "conversation" });
                setHarnessText("");
                setWorkflowPanelOpen(false);
                setHarnessView("active");
              })
              .catch((cause) => setError(String(cause)))
              .finally(finishBusy);
          }}
        />
      )}
      <aside id="task-navigation" ref={navigationPanel} className="task-rail">
        <header>
          <div className="brand">
            <span className="brand-mark">W</span>
            <div>
              <strong>Wave Flow</strong>
              <span>本地 AI 工作台</span>
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
              aria-label="执行环境设置"
            >
              ⚙
            </button>
            <div
              className={`connection ${connected ? "online" : "offline"}`}
              title={
                connected ? "Desktop Engine 已连接" : "Desktop Engine 不可用"
              }
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
            }
          }}
        >
          ⊕ 新建任务
        </button>
        <div className="projects-section-header"
          onClick={() => setProjectsExpanded(!projectsExpanded)}>
          <button
            className="projects-toggle"
            aria-expanded={projectsExpanded}
            aria-controls="project-list"
          >
            项目
          </button>
          <button
            className="project-add"
            aria-label="创建项目"
            onClick={(event) => {
              event.stopPropagation();
              setCreatingProject(true);
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
        <div className="task-section-title" hidden={!projectsExpanded}>
          <div className="harness-tabs" role="tablist" aria-label="会话状态">
            <button
              className={harnessView === "active" ? "active" : ""}
              onClick={() => setHarnessView("active")}
              role="tab"
              aria-selected={harnessView === "active"}
            >
              进行中
            </button>
            <button
              className={harnessView === "completed" ? "active" : ""}
              onClick={() => setHarnessView("completed")}
              role="tab"
              aria-selected={harnessView === "completed"}
            >
              已完成
            </button>
          </div>
        </div>
        <nav className="task-list" id="project-list" hidden={!projectsExpanded}>
          {projects.map((project) => (
            <ProjectGroup
              key={project.projectId}
              project={project}
              harnesses={harnesses.filter(
                (item) =>
                  item.projectId === project.projectId &&
                  (harnessView === "completed"
                    ? item.status === "completed"
                    : item.status !== "completed"),
              )}
              route={route}
              onSelectWorkflow={openWorkflow}
              onArchive={(target) => void archiveTask(target)}
              onRename={async (target, title) => {
                const response = await api.renameTitle(target.harnessRunId, title);
                setHarnesses(current => current.map(item => item.harnessRunId === target.harnessRunId ? newerTaskSnapshot(item, response.harness) : item));
                setHarness(current => current?.harnessRunId === target.harnessRunId ? newerTaskSnapshot(current, response.harness) : current);
              }}
              busyOperations={busyOperations}
              activeHarnessId={harness?.harnessRunId ?? null}
              unreadCounts={unreadCounts}
              showNewSession={harnessView === "active"}
              onNewSession={() => beginHarnessDraft(project.projectId)}
              onSelectHarness={(item) => {
                setSelectedProjectId(project.projectId);
                setHarness(item);
                setRoute({ kind: "conversation" });
                setNavOpen(false);
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
        <div
          className={`rail-width-handle${railDragging ? " dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整任务栏宽度"
          title="拖动调整任务栏宽度"
          onPointerDown={startRailDrag}
        />
      </aside>
      <section
        className="conversation-pane"
        hidden={workflowPanelOpen}
        onClickCapture={(event) => {
          const button = (event.target as HTMLElement).closest<HTMLElement>(
            "button",
          );
          if (button)
            workflowReturn.current = {
              taskId: harness?.harnessRunId ?? null,
              button,
            };
        }}
      >
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
            onTemplate={() => setTemplatePicker(true)}
            onLocal={() => setLocalPreview(true)}
            pendingAttachments={pendingAttachments}
            attachmentBusy={stagingOwner === attachmentOwner}
            attachmentError={attachmentError}
            onDismissAttachmentError={() => setAttachmentError(null)}
            onAddAttachments={() => void addAttachments()}
            onRemoveAttachment={(id) =>
              setPendingAttachments((current) =>
                current.filter((item) => item.stagedId !== id),
              )
            }
          />
        ) : (
          <HarnessConversation
            harness={harness}
            text={harnessText}
            onText={updateHarnessText}
            onSend={() => void sendHarness()}
            onSendImmediate={() => void sendHarness(true)}
            onCancelQueued={(messageId) =>
              void taskMutation(harness.harnessRunId, () =>
                api.cancelQueuedMessage(harness.harnessRunId, messageId),
              ).catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
            }
            onRecover={() =>
              void api
                .recoverController(harness.harnessRunId)
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
            }
            pendingAttachments={pendingAttachments}
            attachmentBusy={stagingOwner === attachmentOwner}
            attachmentError={attachmentError}
            onDismissAttachmentError={() => setAttachmentError(null)}
            onAddAttachments={() => void addAttachments()}
            onRemoveAttachment={(stagedId) =>
              setPendingAttachments((current) =>
                current.filter((item) => item.stagedId !== stagedId),
              )
            }
            onAbort={() => void api.abortHarness(harness.harnessRunId)}
            onComplete={() => {
              const unfinished =
                harness.impactSummaries?.filter(
                  (item) => !item.supersededBy && item.status !== "completed",
                ) ?? [];
              if (unfinished.length) {
                setArchiveConfirmation({
                  harnessRunId: harness.harnessRunId,
                  count: unfinished.length,
                });
                return;
              }
              const finishBusy = beginBusy(
                  `task:${harness.harnessRunId}`,
                  "complete-harness",
                ),
                pageToken = navigationToken.current;
              void taskMutation(harness.harnessRunId, () =>
                api.completeHarness(harness.harnessRunId),
              )
                .then((response) => {
                  if (
                    pageToken !== navigationToken.current ||
                    harnessRef.current?.harnessRunId !==
                      response.harness.harnessRunId
                  )
                    return;
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
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(finishBusy);
            }}
            onOpenWorkflow={() => {
              const revision = workflowCells(harness).at(-1);
              if (revision) openWorkflow(harness, revision);
            }}
            hasWorkflow={harness.workflowRevisions.length > 0}
            onDraft={() => {}}
            onTemplate={() => setTemplatePicker(true)}
            onRuntimeSettings={() => setSettingsOpen(true)}
            onRetryInitialization={() =>
              taskMutation(harness.harnessRunId, () =>
                api.retryInitialization(harness.harnessRunId),
              )
            }
            onAccept={async (revision) => {
              try {
                await taskMutation(harness.harnessRunId, () =>
                  api.acceptWorkflowRevision(harness.harnessRunId, revision),
                );
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              }
            }}
            onReject={async (revision) => {
              await taskMutation(harness.harnessRunId, () =>
                api.rejectWorkflowRevision(harness.harnessRunId, revision),
              );
            }}
            onAssignmentCreated={(detail) => void finishAssignment(detail)}
            onSelectRevision={(revision) =>
              openWorkflow(harness, revision, "plan")
            }
            onSelectResults={(executionId) => {
              const execution = harness.executions.find(
                (item) => item.executionId === executionId,
              );
              const revision =
                execution &&
                harness.workflowRevisions.find(
                  (item) => item.revision === execution.revision,
                );
              if (revision)
                openWorkflow(harness, revision, "results", executionId);
            }}
            draftContext={
              adjustContext?.taskId === harness.harnessRunId
                ? `针对${adjustContext.abandoned ? "已放弃的" : ""}第 ${adjustContext.revision} 版方案`
                : undefined
            }
            onAdjustRevision={(revision) =>
              prepareRevisionDraft(harness, revision, !!revision.abandonedAt)
            }
            onSelectExecution={(executionId, attempt) =>
              void selectExecution(executionId, attempt)
            }
            onAnswerDecision={async (decisionId, answer) => {
              const finishBusy = beginBusy(
                `task:${harness.harnessRunId}`,
                `decision:${decisionId}`,
              );
              try {
                await taskMutation(harness.harnessRunId, () =>
                  api.answerHarnessDecision(
                    harness.harnessRunId,
                    decisionId,
                    answer,
                  ),
                );
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
        {archiveConfirmation &&
          harness?.harnessRunId === archiveConfirmation.harnessRunId && (
            <ArchiveImpactConfirmation
              count={archiveConfirmation.count}
              onClose={() => setArchiveConfirmation(null)}
              onConfirm={() => {
                const id = archiveConfirmation.harnessRunId,
                  pageToken = navigationToken.current,
                  finishBusy = beginBusy(
                    `task:${id}`,
                    "archive-abandon-summary",
                  );
                setArchiveConfirmation(null);
                void taskMutation(id, () => api.archiveAbandoningSummaries(id))
                  .then(() => {
                    if (
                      pageToken !== navigationToken.current ||
                      harnessRef.current?.harnessRunId !== id
                    )
                      return;
                    setHarnessView("active");
                    setDraftProjectId(projects[0]?.projectId ?? null);
                    setHarness(null);
                    setHarnessText("");
                    setWorkflowPanelOpen(false);
                    setError(null);
                  })
                  .catch((error) => {
                    if (
                      pageToken === navigationToken.current &&
                      harnessRef.current?.harnessRunId === id
                    )
                      setError(String(error));
                  })
                  .finally(finishBusy);
              }}
            />
          )}
        {templatePicker && (
          <TemplatePicker
            key={
              harness?.harnessRunId ??
              `project:${draftProjectId ?? selectedProjectId}`
            }
            identity={
              harness?.harnessRunId ??
              `project:${draftProjectId ?? selectedProjectId}`
            }
            blockedReason={
              harness &&
              (harness.status !== "idle" ||
                harness.executions.some((item) => item.finishedAt === null))
                ? "Wave Flow 或执行仍在处理中；参数保留，结束后才能保存。"
                : undefined
            }
            onClose={() => setTemplatePicker(false)}
            onSave={async (selection, requestId) => {
              const owner = harnessRef.current,
                token = navigationToken.current;
              const response = owner
                ? await taskMutation(owner.harnessRunId, () =>
                    api.saveTemplate(owner.harnessRunId, requestId, selection),
                  )
                : await api.createTemplateTask(
                    draftProjectId ?? selectedProjectId!,
                    "只读代码审查与独立复核",
                    requestId,
                    selection,
                  );
              setHarnesses((current) => [
                response.harness,
                ...current.filter(
                  (item) => item.harnessRunId !== response.harness.harnessRunId,
                ),
              ]);
              if (
                token === navigationToken.current &&
                (owner
                  ? harnessRef.current?.harnessRunId === owner.harnessRunId
                  : !harnessRef.current)
              ) {
                if (selection.needsGuidance) {
                  setTemplatePicker(false);
                  setHarness(response.harness);
                  setDraftProjectId(null);
                  setRoute({ kind: "conversation" });
                } else
                  openWorkflow(
                    response.harness,
                    response.harness.workflowRevisions.at(-1)!,
                  );
              }
            }}
          />
        )}
      </section>
      {localPreview &&
        (harness?.projectId ?? draftProjectId ?? selectedProjectId) && (
          <LocalWorkflowPreview
            projectId={
              (harness?.projectId ?? draftProjectId ?? selectedProjectId)!
            }
            revision={localRevision ?? undefined}
            replacement={
              !localRevision && harness
                ? {
                    harnessRunId: harness.harnessRunId,
                    baseRevision: harness.workflowRevisions.at(-1)!.revision,
                  }
                : undefined
            }
            onClose={() => {
              setLocalPreview(false);
              setLocalRevision(null);
            }}
            onPrepared={(response) => {
              setLocalPreview(false);
              setLocalRevision(null);
              setHarness(response.harness);
              setHarnesses((current) => [
                response.harness,
                ...current.filter(
                  (item) => item.harnessRunId !== response.harness.harnessRunId,
                ),
              ]);
              setDraftProjectId(null);
              openWorkflow(
                response.harness,
                response.harness.workflowRevisions.at(-1)!,
                "plan",
              );
            }}
          />
        )}
      <aside
        ref={centralScroll}
        onScroll={() => {
          if (route.kind === "workflow" && centralScroll.current)
            detailPositions.set(pageKey, centralScroll.current.scrollTop);
        }}
        className="central-workflow"
        hidden={!workflowPanelOpen}
      >
        <WorkflowPanelErrorBoundary onClose={() => setWorkflowPanelOpen(false)}>
          <header className="workflow-page-header">
            <div>
              <span>
                {harness
                  ? `${conversationTitle(harness)} / 方案`
                  : "工作流详情"}
              </span>
              <strong
                ref={workflowTitle}
                tabIndex={-1}
                role="heading"
                aria-level={1}
              >
                {(() => {
                  const headerRevision =
                    route.kind === "workflow"
                      ? harness?.workflowRevisions.find(
                          (item) => item.revision === route.revision,
                        )
                      : undefined;
                  return headerRevision
                    ? proposalTitle(headerRevision)
                    : "工作流详情";
                })()}
              </strong>
            </div>
            <button
              onClick={() => setWorkflowPanelOpen(false)}
              aria-label="返回对话"
            >
              返回对话
              {harness && (unreadCounts.get(harness.harnessRunId) ?? 0) > 0
                ? `（${unreadCounts.get(harness.harnessRunId)} 条未读）`
                : ""}
            </button>
          </header>
          {harness &&
            route.kind === "workflow" &&
            !routeMatchesTask(harness, route) && (
              <p role="alert">所选工作流记录已失效，请返回对话重新选择。</p>
            )}
          {harness &&
            route.kind === "workflow" &&
            routeMatchesTask(harness, route) && (
              <div className="central-plan">
                <div
                  className="workflow-page-tabs"
                  role="tablist"
                  aria-label="工作流详情"
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    const buttons = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        "button:not(:disabled)",
                      ),
                    ];
                    const index = buttons.indexOf(
                      document.activeElement as HTMLButtonElement,
                    );
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? buttons.length - 1
                          : (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              buttons.length) %
                            buttons.length;
                    event.preventDefault();
                    buttons[next]?.focus();
                    buttons[next]?.click();
                  }}
                >
                  <button
                    role="tab"
                    aria-selected={route.section === "plan"}
                    onClick={() => setRoute({ ...route, section: "plan" })}
                  >
                    方案
                  </button>
                  <button
                    role="tab"
                    aria-selected={route.section === "execution"}
                    disabled={
                      !harness.executions.some(
                        (item) => item.revision === route.revision,
                      )
                    }
                    onClick={() => {
                      const ex = harness.executions.find(
                        (item) => item.revision === route.revision,
                      );
                      if (ex) setSelectedExecutionId(ex.executionId);
                      setRoute({
                        ...route,
                        section: "execution",
                        executionId: ex?.executionId,
                      });
                    }}
                  >
                    执行
                  </button>
                  <button
                    role="tab"
                    aria-selected={route.section === "results"}
                    disabled={
                      !harness.executions.some(
                        (item) => item.revision === route.revision,
                      )
                    }
                    onClick={() => {
                      const ex = harness.executions.find(
                        (item) => item.revision === route.revision,
                      );
                      if (ex) setSelectedExecutionId(ex.executionId);
                      setRoute({
                        ...route,
                        section: "results",
                        executionId: ex?.executionId,
                      });
                    }}
                  >
                    结果
                  </button>
                </div>
                {harness.status === "running" && (
                  <button onClick={() => setRoute({ kind: "conversation" })}>
                    {harness.decisions.some((item) => !item.answer)
                      ? "需要你的回答"
                      : "Wave Flow 正在处理"}{" "}
                    · 返回对话
                  </button>
                )}
                {harness.executions
                  .filter((execution) => {
                    const attention = harnesses.find(
                      (task) => task.harnessRunId === harness.harnessRunId,
                    )?.executionAttention?.[execution.executionId];
                    return (
                      execution.finishedAt === null &&
                      attention &&
                      (attention.workerRequests > 0 ||
                        attention.scriptGates > 0)
                    );
                  })
                  .map((execution) => (
                    <button
                      key={execution.executionId}
                      onClick={() =>
                        void selectExecution(execution.executionId)
                      }
                    >
                      执行需要回答 · 前往所属执行
                    </button>
                  ))}
                {route.section === "plan" &&
                  (() => {
                    const revisions = harness.workflowRevisions.filter(
                      (item) =>
                        (item.cardId ?? `legacy:${item.revision}`) ===
                        route.cardId,
                    );
                    const revision = revisions.find(
                      (item) => item.revision === route.revision,
                    );
                    if (!revision) return <p>方案不存在，请返回对话。</p>;
                    return (
                      <div className="workflow-plan-content">
                        <div className="workflow-version-tools">
                          <WorkflowVersions
                            versions={revisions}
                            selected={revision.revision}
                            onSelect={(selected) => {
                              setSelectedExecutionId(null);
                              setExecutionDetail(null);
                              setRoute({
                                ...route,
                                revision: selected,
                                executionId: undefined,
                                attempt: undefined,
                              });
                            }}
                          />
                        </div>
                        <WorkflowRevisionCard
                          key={`${route.taskId}:${revision.revision}`}
                          revision={revision}
                          harness={harness}
                          onLocalRevision={
                            revision.localOrigin
                              ? () => {
                                  setLocalRevision({
                                    harnessRunId: harness.harnessRunId,
                                    baseRevision: revision.revision,
                                    path: revision.localOrigin!.path,
                                    input: revision.input ?? {},
                                  });
                                  setLocalPreview(true);
                                }
                              : undefined
                          }
                          onSaved={(next) => {
                            setHarnesses((current) =>
                              current.map((item) =>
                                item.harnessRunId === next.harnessRunId
                                  ? newerTaskSnapshot(item, next)
                                  : item,
                              ),
                            );
                            if (
                              harnessRef.current?.harnessRunId ===
                                next.harnessRunId &&
                              routeRef.current.kind === "workflow" &&
                              routeRef.current.cardId === revision.cardId &&
                              routeRef.current.revision === revision.revision
                            )
                              openWorkflow(
                                next,
                                next.workflowRevisions.at(-1)!,
                                "plan",
                              );
                          }}
                          onAssignmentCreated={(detail) =>
                            void finishAssignment(detail)
                          }
                          onAdjustViaChat={
                            !revision.localOrigin
                              ? () =>
                                  prepareRevisionDraft(harness, revision, false)
                              : undefined
                          }
                          onAbandonCard={
                            editableRevision(harness, revision)
                              ? async () => {
                                  await taskMutation(harness.harnessRunId, () =>
                                    api.abandonCard(
                                      harness.harnessRunId,
                                      revision.cardId!,
                                    ),
                                  );
                                }
                              : undefined
                          }
                        />
                        {revision.abandonedAt &&
                          harness.workflowRevisions.at(-1)?.revision ===
                            revision.revision &&
                          harness.status !== "completed" && (
                            <AbandonedPlan
                              onRedesign={() =>
                                prepareRevisionDraft(harness, revision, true)
                              }
                              onTemplate={
                                !harness.executions.length
                                  ? () => setTemplatePicker(true)
                                  : undefined
                              }
                              disabled={
                                harness.status !== "idle" ||
                                harness.executions.some(
                                  (item) => !item.finishedAt,
                                )
                              }
                            />
                          )}
                      </div>
                    );
                  })()}
                {route.section === "results" && executionDetail && (
                  <HistoricalResults
                    key={`${harness.harnessRunId}:${executionDetail.execution.executionId}`}
                    taskId={harness.harnessRunId}
                    executionId={executionDetail.execution.executionId}
                    currentAttempt={
                      executionDetail.snapshot.currentExecutionAttemptId
                    }
                    selectedAttempt={route.attempt}
                    onSelectAttempt={(attempt) =>
                      setRoute({ ...route, attempt })
                    }
                    harness={harness}
                  />
                )}
              </div>
            )}
          {executionDetail &&
          harness &&
          route.kind === "workflow" &&
          routeMatchesTask(harness, route) &&
          route.section === "execution" ? (
            <div className="workflow-detail-scroll">
              <ExecutionDetail
                readOnly={
                  harness.status === "completed" ||
                  (harness.task?.workflowContract === "single-workflow-v1" &&
                    harness.executions.at(-1)?.executionId !==
                      executionDetail.execution.executionId)
                }
                detail={executionDetail}
                selectedAttempt={route.attempt}
                onSelectAttempt={(attempt) => setRoute({ ...route, attempt })}
                busy={executionBusy}
                dynamicCount={executionDynamicCount}
                harnessRunId={harness.harnessRunId}
                theme={theme}
                previousRecords={(harness.executionHistory ?? [])
                  .filter(
                    (item) =>
                      item.executionId ===
                        executionDetail.execution.executionId &&
                      item.kind === "finished",
                  )
                  .map((item) => ({
                    id: item.attempt ?? 1,
                    at: item.at,
                    status: item.status,
                  }))}
                onControl={controlExecution}
                onSavePartial={async () => {
                  const owner = harness.harnessRunId,
                    id = executionDetail.execution.executionId;
                  const valid = requestFence.current.begin(
                    `execution:${owner}:${id}`,
                  );
                  const finishBusy = beginBusy(
                    `execution:${id}`,
                    "save-partial",
                  );
                  try {
                    const next = await api.savePartial(owner, id);
                    if (valid() && harnessRef.current?.harnessRunId === owner)
                      setExecutionDetail(next);
                  } finally {
                    finishBusy();
                  }
                }}
                onCleanupWorkspaces={async () => {
                  const owner = harness.harnessRunId,
                    id = executionDetail.execution.executionId;
                  const valid = requestFence.current.begin(
                    `execution:${owner}:${id}`,
                  );
                  const finishBusy = beginBusy(
                    `execution:${id}`,
                    "cleanup-workspaces",
                  );
                  try {
                    const next = await api.cleanupWorkspaces(owner, id);
                    if (valid() && harnessRef.current?.harnessRunId === owner)
                      setExecutionDetail(next);
                  } finally {
                    finishBusy();
                  }
                }}
                onAnswerBlock={async (blockId, answer) => {
                  const valid = requestFence.current.begin(
                    `execution:${harness.harnessRunId}:${executionDetail.execution.executionId}`,
                  );
                  const finishBusy = beginBusy(
                    `execution:${executionDetail.execution.executionId}`,
                    `answer:${blockId}`,
                  );
                  try {
                    await api.answer(blockId, answer);
                    const next = await api.execution(
                      harness.harnessRunId,
                      executionDetail.execution.executionId,
                    );
                    if (
                      valid() &&
                      harnessRef.current?.harnessRunId ===
                        harness.harnessRunId &&
                      routeRef.current.kind === "workflow" &&
                      routeRef.current.executionId ===
                        next.execution.executionId
                    )
                      setExecutionDetail(next);
                  } finally {
                    finishBusy();
                  }
                }}
                onAnswer={async (gateId, answer) => {
                  const valid = requestFence.current.begin(
                    `execution:${harness.harnessRunId}:${executionDetail.execution.executionId}`,
                  );
                  const finishBusy = beginBusy(
                    `execution:${executionDetail.execution.executionId}`,
                    `gate:${gateId}`,
                  );
                  try {
                    const next = await api.answerExecutionGate(
                      harness.harnessRunId,
                      executionDetail.execution.executionId,
                      gateId,
                      answer,
                    );
                    if (
                      valid() &&
                      harnessRef.current?.harnessRunId ===
                        harness.harnessRunId &&
                      routeRef.current.kind === "workflow" &&
                      routeRef.current.executionId ===
                        next.execution.executionId
                    )
                      setExecutionDetail(next);
                  } finally {
                    finishBusy();
                  }
                }}
              />
            </div>
          ) : null}
        </WorkflowPanelErrorBoundary>
      </aside>
      {creatingProject && (
        <ProjectCreateDialog
          onClose={() => setCreatingProject(false)}
          onCreated={(project) => {
            setProjects((current) => [
              project,
              ...current.filter((item) => item.projectId !== project.projectId),
            ]);
            setProjectsExpanded(true);
            setCreatingProject(false);
            setError(null);
            beginHarnessDraft(project.projectId);
          }}
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
  if (
    /Desktop Engine (已退出|请求超时|管道错误|未运行)|无法发送 Engine 请求/.test(
      message,
    )
  ) {
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
  const panel = useRef<HTMLElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose),
    busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const activePanel = panel.current;
    if (!activePanel) return;
    const prior = document.activeElement as HTMLElement | null;
    const background: Array<{ element: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement = activePanel;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    cancel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key === "Tab") {
        const items = [
            ...activePanel.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ],
          first = items[0],
          last = items.at(-1);
        if (!items.length) {
          event.preventDefault();
          activePanel.focus();
        } else if (!activePanel.contains(document.activeElement)) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      background.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      requestAnimationFrame(() => {
        const navigation = document.querySelector<HTMLElement>(
          '[aria-label="打开任务导航"]',
        );
        const target = [
          prior,
          navigation,
          document.querySelector<HTMLElement>('[aria-label="执行环境设置"]'),
        ].find(
          (item) =>
            item?.isConnected &&
            item !== document.body &&
            item !== document.documentElement &&
            item.getClientRects().length > 0 &&
            !item.closest("[inert]"),
        );
        target?.focus();
      });
    };
  }, []);
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
        ref={panel}
        tabIndex={-1}
        className="connection-panel restart-modal"
        role="dialog"
        aria-modal="true"
        aria-label="确认退出 Wave Flow"
      >
        <header className="connection-panel-head">
          <div>
            <span className="modal-kicker">Wave Flow</span>
            <strong>退出 Wave Flow？</strong>
            <p>这会停止正在进行的任务，并关闭 Wave Flow。</p>
          </div>
        </header>
        <section className="connection-form">
          <footer className="modal-actions">
            <button
              ref={cancel}
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

/** 设置分区标识：通用 / CLI 设置 / 诊断。 */
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
  const settingsPanel = useRef<HTMLElement>(null),
    manualPanel = useRef<HTMLElement>(null),
    manualErrorRef = useRef<HTMLDivElement>(null);
  const settingsClose = useRef(onClose);
  settingsClose.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    return () => {
      requestAnimationFrame(() => {
        const settings = document.querySelector<HTMLElement>(
          '[aria-label="执行环境设置"]',
        );
        const navigation = document.querySelector<HTMLElement>(
          '[aria-label="打开任务导航"]',
        );
        const target = [settings, navigation, prior].find(
          (item) => item?.isConnected && item.getClientRects().length > 0,
        );
        target?.focus();
      });
    };
  }, []);
  useEffect(() => {
    const activePanel = manualOpen
      ? manualPanel.current
      : settingsPanel.current;
    if (!activePanel) return;
    // 沿弹窗祖先只禁用兄弟区域，内层弹窗不会把包含自身的外层设为inert。
    const background: Array<{ element: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement = activePanel;
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    const controls = () =>
      [
        ...activePanel.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        ),
      ].filter(
        (item) => !item.closest("[inert]") && item.getClientRects().length > 0,
      );
    (manualOpen
      ? activePanel.querySelector<HTMLInputElement>("input")
      : (activePanel.querySelector<HTMLElement>(".modal-close") ??
        controls()[0])
    )?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (manualOpen) setManualOpen(false);
        else if (!gateMode) settingsClose.current?.();
      }
      if (event.key === "Tab") {
        const items = controls(),
          first = items[0],
          last = items.at(-1);
        if (!items.length) {
          event.preventDefault();
          return;
        }
        if (!activePanel.contains(document.activeElement)) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      background.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      if (manualOpen)
        requestAnimationFrame(() =>
          settingsPanel.current
            ?.querySelector<HTMLElement>(".add-runtime")
            ?.focus(),
        );
    };
  }, [manualOpen, gateMode]);
  /** 手动验证失败必须在二级弹窗内可见；全局 toast 只是补充，不作为唯一反馈。 */
  const [manualError, setManualError] = useState<string | null>(null);
  useEffect(() => {
    if (manualError) manualErrorRef.current?.focus();
  }, [manualError]);
  const [runtimeOperation, setRuntimeOperation] = useState<
    "scan" | "validate" | "select" | null
  >(null);
  const runtimeBusy = runtimeOperation !== null;
  /** WKWebView 不支持 window.confirm；切换主控用两段式按钮确认，timer 只负责超时复位。 */
  const [confirmSwitchId, setConfirmSwitchId] = useState<string | null>(null);
  const confirmSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [section, setSection] = useState<SettingsSection>("general");
  const [engineStatus, setEngineStatus] =
    useState<DesktopStatusResponse | null>(null);
  const [engineStatusError, setEngineStatusError] = useState<string | null>(
    null,
  );
  const selected =
    runtimeState.runtimes.find(
      (runtime) => runtimeState.harnessRuntimeId === runtime.runtimeId,
    ) ?? null;
  // 与 Orca 一致：每个 CLI 只呈现当前选中的那个安装，其余安装默认折叠。
  const preferredByCli = (() => {
    const byCli = new Map<CliRuntime["cli"], CliRuntime>();
    for (const runtime of runtimeState.runtimes) {
      const preferredId = runtimeState.selectedByCli?.[runtime.cli];
      if (!byCli.has(runtime.cli) || runtime.runtimeId === preferredId)
        byCli.set(runtime.cli, runtime);
    }
    return [...byCli.values()];
  })();
  const otherRuntimes = preferredByCli.filter(
    (runtime) =>
      runtime.runtimeId !== selected?.runtimeId &&
      runtime.cli !== selected?.cli,
  );
  const shownIds = new Set([
    ...(selected ? [selected.runtimeId] : []),
    ...otherRuntimes.map((runtime) => runtime.runtimeId),
  ]);
  const extraRuntimes = runtimeState.runtimes.filter(
    (runtime) => !shownIds.has(runtime.runtimeId),
  );
  const reloadRuntimes = useCallback(async () => {
    onRuntimeState(await api.cliRuntimes());
  }, [onRuntimeState]);
  const loadEngineStatus = useCallback(async () => {
    try {
      setEngineStatus(await api.desktopStatus());
      setEngineStatusError(null);
    } catch (cause) {
      setEngineStatusError(
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }, []);
  useEffect(() => {
    if (section === "diagnostics") void loadEngineStatus();
  }, [section, loadEngineStatus]);
  async function scan() {
    // PATH 扫描护栏：进行中禁止重复触发；结果写回 App 级 runtimeState，
    // 扫描期间切换分区不会丢弃返回结果。
    if (runtimeBusy || scanning) return;
    setRuntimeOperation("scan");
    try {
      onRuntimeState((await api.scanCliRuntimes()).runtimes);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRuntimeOperation(null);
    }
  }
  async function validate() {
    if (runtimeBusy || !manualPath.trim()) return;
    setRuntimeOperation("validate");
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
      setRuntimeOperation(null);
    }
  }
  async function selectRuntime(runtime: CliRuntime) {
    if (runtimeBusy || scanning) return;
    if (
      selected &&
      selected.runtimeId !== runtime.runtimeId &&
      confirmSwitchId !== runtime.runtimeId
    ) {
      // 第一次点击只进入待确认态；4 秒内再次点击才执行切换。
      setConfirmSwitchId(runtime.runtimeId);
      if (confirmSwitchTimer.current) clearTimeout(confirmSwitchTimer.current);
      confirmSwitchTimer.current = setTimeout(
        () => setConfirmSwitchId(null),
        4_000,
      );
      return;
    }
    setConfirmSwitchId(null);
    setRuntimeOperation("select");
    try {
      await api.selectCliRuntime(runtime.runtimeId);
      await reloadRuntimes();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRuntimeOperation(null);
    }
  }

  const runtimeRow = (runtime: CliRuntime) => {
    const isDefault = runtimeState.harnessRuntimeId === runtime.runtimeId;
    const statusLabel =
      runtime.status === "verified"
        ? null
        : runtime.status === "needs-revalidation"
          ? "需重新验证"
          : "验证失败";
    return (
      <article key={runtime.runtimeId} className={isDefault ? "selected" : ""}>
        <span className={`runtime-icon ${runtime.cli}`} aria-hidden="true">
          {runtime.cli === "codex" ? "C" : "K"}
        </span>
        <div>
          <strong>
            {runtime.cli === "codex" ? "Codex CLI" : "Kimi CLI"}
            {isDefault && <em className="runtime-badge">默认</em>}
            {statusLabel && <em className="runtime-badge warn">{statusLabel}</em>}
          </strong>
          <small className="runtime-version">{runtime.version}</small>
          <details className="runtime-technical">
            <summary>技术信息</summary>
            <CopyablePath path={runtime.executablePath} />
            <small>
              adapter {runtime.verifiedAdapter.adapterId} ·{" "}
              {runtime.verifiedAdapter.harnessTools ? "对话与执行" : "仅执行"}
            </small>
          </details>
          {runtime.diagnostic && <p>{userFacingText(runtime.diagnostic)}</p>}
        </div>
        <div className="runtime-row-actions">
          {isDefault ? null : runtime.status === "verified" &&
            runtime.verifiedAdapter.harnessTools ? (
            <button
              className="button-secondary"
              disabled={runtimeBusy}
              onClick={() => void selectRuntime(runtime)}
            >
              {confirmSwitchId === runtime.runtimeId
                ? "确认切换？"
                : "设为默认"}
            </button>
          ) : (
            <span className="runtime-passive">
              {runtime.status === "needs-revalidation"
                ? "需重新验证"
                : runtime.status === "invalid"
                  ? "验证失败"
                  : "仅可用于执行"}
            </span>
          )}
        </div>
      </article>
    );
  };

  const cliContent = (
    <>
      <section className="connection-form runtime-actions">
        <div className="section-row">
          <div>
            <strong>CLI</strong>
            <span>
              {selected
                ? "切换只影响新会话；正在处理的会话会阻止切换。"
                : "从 PATH 自动发现，或手动添加一个绝对路径。"}
            </span>
          </div>
          <div className="runtime-actions-group">
            {!gateMode && (
              <button
                className="button-secondary"
                disabled={runtimeBusy || scanning}
                onClick={() => void scan()}
              >
                {runtimeOperation === "scan" || scanning
                  ? "正在扫描…"
                  : "重新扫描"}
              </button>
            )}
            <button
              className="button-secondary add-runtime"
              disabled={runtimeBusy}
              onClick={() => {
                setManualError(null);
                setManualOpen(true);
              }}
            >
              手动添加
            </button>
          </div>
        </div>
        {!manualOpen && manualError && (
          <p role="alert" className="manual-validation-feedback">
            验证未通过：{manualError} 请重新打开手动添加，检查路径后重试。
          </p>
        )}
        {!manualOpen && runtimeOperation === "validate" && (
          <p role="status">
            正在验证 CLI，结束后结果会显示在这里；不会自动设为默认。
          </p>
        )}
        {runtimeOperation === "select" && (
          <p role="status">正在切换默认 CLI…</p>
        )}
      </section>
      <section className="runtime-list">
        {!(selected || otherRuntimes.length) && (
          <span className="list-caption">
            {scanning ? "正在验证候选…" : "尚未发现可用 CLI"}
          </span>
        )}
        {[...(selected ? [selected] : []), ...otherRuntimes].map(runtimeRow)}
        {extraRuntimes.length > 0 && (
          <details className="runtime-extras">
            <summary>其他安装（{extraRuntimes.length}）</summary>
            {extraRuntimes.map(runtimeRow)}
          </details>
        )}
      </section>
      {manualOpen && (
        <div
          className="connection-nested-backdrop"
          onMouseDown={() => setManualOpen(false)}
        >
          <section
            ref={manualPanel}
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
                  disabled={runtimeBusy}
                  value={manualCli}
                  onChange={(event) => {
                    setManualCli(event.target.value as "codex" | "kimi");
                    setManualError(null);
                  }}
                >
                  <option value="codex">Codex CLI</option>
                  <option value="kimi">Kimi CLI</option>
                </select>
              </label>
              <label className="connection-field">
                <span>CLI 绝对路径</span>
                <input
                  autoFocus
                  disabled={runtimeBusy}
                  value={manualPath}
                  onChange={(event) => {
                    setManualPath(event.target.value);
                    setManualError(null);
                  }}
                  placeholder={
                    manualCli === "kimi"
                      ? "/Users/you/.kimi-code/bin/kimi"
                      : "/Users/you/.local/bin/codex"
                  }
                  spellCheck={false}
                />
              </label>
              {manualError && (
                <div
                  ref={manualErrorRef}
                  tabIndex={-1}
                  className="manual-runtime-error"
                  role="alert"
                >
                  <span>!</span>
                  <p>{manualError}</p>
                </div>
              )}
              {runtimeBusy && (
                <p role="status">
                  正在验证所选
                  CLI。关闭窗口不会取消验证，结果会更新到设置中；不会自动设为默认。
                </p>
              )}
              <footer className="modal-actions">
                <button
                  className="button-secondary"
                  onClick={() => setManualOpen(false)}
                >
                  {runtimeBusy ? "关闭窗口" : "取消"}
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
          ref={settingsPanel}
          className="connection-panel runtime-settings runtime-settings--gate"
          aria-label="选择 Wave Flow CLI"
          aria-modal="true"
          role="dialog"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="connection-panel-head">
            <div>
              <span className="modal-kicker">本机执行底座</span>
              <strong>选择 Wave Flow CLI</strong>
              <p>
                选择一个已验证的本机 CLI，让 Wave Flow
                帮你处理任务。扫描不会自动修改默认项。
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
        ref={settingsPanel}
        className="connection-panel runtime-settings settings-panel"
        aria-label="设置"
        aria-modal="true"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="connection-panel-head settings-head">
          <div className="settings-head-row">
            <strong>设置</strong>
            <button
              className="settings-close"
              type="button"
              onClick={onClose}
            >
              返回工作台
            </button>
          </div>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
            {(
              [
                ["general", "通用"],
                ["cli", "CLI 设置"],
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
                <div
                  className="settings-theme"
                  role="radiogroup"
                  aria-label="外观主题"
                >
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
                    <span>
                      来自 Engine 权威摘要；页面不由此推断或改变 Run 状态。
                    </span>
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
                    <dt>正在处理的会话</dt>
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
                    <strong>当前默认 CLI 来源</strong>
                    <span>用于审计本机执行底座的真实落点。</span>
                  </div>
                </div>
                {selected ? (
                  <dl className="settings-diag-list">
                    <dt>CLI</dt>
                    <dd>
                      {selected.cli === "codex" ? "Codex CLI" : "Kimi CLI"}
                    </dd>
                    <dt>路径</dt>
                    <dd>
                      <CopyablePath path={selected.executablePath} />
                    </dd>
                    <dt>版本</dt>
                    <dd>{selected.version}</dd>
                    <dt>发现来源</dt>
                    <dd>
                      {discoveredFromLabel(selected.discoveredFrom)}
                      {selected.discoveredShell
                        ? `（${selected.discoveredShell}）`
                        : ""}
                    </dd>
                    <dt>验证 Adapter</dt>
                    <dd>
                      {selected.verifiedAdapter.adapterId} ·{" "}
                      {selected.verifiedAdapter.adapterVersion} · ACP v
                      {selected.verifiedAdapter.acpProtocolVersion}
                    </dd>
                    <dt>验证时间</dt>
                    <dd>{localeTime(selected.verifiedAt)}</dd>
                  </dl>
                ) : (
                  <p className="settings-note">尚未设置 Wave Flow CLI。</p>
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
  unread = 0,
  onRename,
}: {
  item: HarnessSnapshot;
  active: boolean;
  onClick: () => void;
  /** 未阅读的耐久条目数；不按流式片段计数。 */
  unread?: number;
  /** 保存该行Task名称，不改变导航。 */ onRename: (title: string) => Promise<void>;
}) {
  return (
    <TaskTitleEditor
      className={`harness-list-item ${active ? "active" : ""}`}
      title={conversationTitle(item)}
      readOnly={item.status === "completed" || !item.task}
      onSelect={onClick}
      onSave={onRename}
      hoverContent={<>
        <strong>{conversationTitle(item)}</strong>
        <div className="sidebar-hover-project"><span className="folder-glyph" aria-hidden="true" />{item.cwd.split("/").filter(Boolean).at(-1) ?? "项目"}</div>
        <div className="sidebar-hover-meta">
          <span>{item.status === "running" ? "进行中" : item.status === "interrupted" ? "已中断" : item.status === "completed" ? "已完成" : item.executions.some(execution => execution.finishedAt === null) ? "执行中" : interruptedSummaryObligations(item).length ? "总结未完成" : "可继续"}</span>
          <time dateTime={item.completedAt ?? item.createdAt}>{new Date(item.completedAt ?? item.createdAt).toLocaleString("zh-CN")}</time>
        </div>
        {item.decisions.some(decision => decision.answer === null) && item.status === "running" && <small>需要你的回答</small>}
        {hasActiveExecutionQuestions(item) && <small>执行需要回答</small>}
      </>}
    >
      <span className={`task-presence ${item.status}`} />
      <div className="sidebar-title-line">
        <strong>{conversationTitle(item)}</strong>
        {unread > 0 && <span className="task-unread">{unread} 条未读</span>}
      </div>
    </TaskTitleEditor>
  );
}
function TaskTreeItem({
  item,
  active,
  route,
  unread,
  onClick,
  onWorkflow,
  onRename,
}: {
  item: HarnessSnapshot;
  unread: number;
  active: boolean;
  route: WorkbenchRoute;
  onClick: () => void;
  onWorkflow: (revision: import("./types").WorkflowRevision) => void;
  /** 人工保存当前行标题。 */ onRename: (title: string) => Promise<void>;
}) {
  return (
    <div className="task-tree-item">
      <HarnessListItem
        item={item}
        unread={unread}
        active={active}
        onClick={onClick}
        onRename={onRename}
      />
    </div>
  );
}
function ProjectGroup({
  project,
  harnesses,
  activeHarnessId,
  unreadCounts,
  route,
  onSelectWorkflow,
  onArchive,
  onRename,
  busyOperations,
  showNewSession,
  onNewSession,
  onSelectHarness,
}: {
  project: HarnessProject;
  harnesses: HarnessSnapshot[];
  activeHarnessId: string | null;
  /** 各 Task 的本地阅读计数；不构成业务状态。 */
  unreadCounts: Map<string, number>;
  route: WorkbenchRoute;
  /** 点击任务行归档入口，先确认，不切换阅读任务。 */
  onArchive: (task: HarnessSnapshot) => void;
  /** 保存指定Task名称，不依赖当前阅读选择。 */ onRename: (task: HarnessSnapshot, title: string) => Promise<void>;
  /** 任务级操作状态，用于防止重复归档。 */
  busyOperations: Record<string, string>;
  onSelectWorkflow: (
    task: HarnessSnapshot,
    revision: import("./types").WorkflowRevision,
    section?: "plan" | "execution" | "results",
    executionId?: string,
  ) => void;
  showNewSession: boolean;
  onNewSession: () => void;
  onSelectHarness: (harness: HarnessSnapshot) => void;
}) {
  const [expanded, setExpanded] = useProjectExpanded(
    `project:${project.projectId}`,
  );
  return (
    <section className="project-group">
      <header>
        <button
          title={project.title}
          aria-expanded={expanded}
          aria-controls={`project-tasks-${project.projectId}`}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="folder-glyph" aria-hidden="true">
            ⌑
          </span>
          <strong>{project.title}</strong>
        </button>
        {showNewSession && (
          <button
            className="project-new-session"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(true);
              onNewSession();
            }}
            aria-label={`在 ${project.title} 新建会话`}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 3.25v9.5M3.25 8h9.5" />
            </svg>
          </button>
        )}
      </header>
      {
        <div
          className="project-conversations"
          id={`project-tasks-${project.projectId}`}
          hidden={!expanded}
        >
          {harnesses.map((item) => (
            <div
              key={item.harnessRunId}
              className={`task-row ${item.harnessRunId === activeHarnessId ? "selected" : ""}`}
            >
              <TaskTreeItem
                item={item}
                unread={unreadCounts.get(item.harnessRunId) ?? 0}
                active={item.harnessRunId === activeHarnessId}
                route={route}
                onClick={() => onSelectHarness(item)}
                onWorkflow={(revision) => onSelectWorkflow(item, revision)}
                onRename={title => onRename(item, title)}
              />
              {item.status !== "completed" && (
                <button
                  className="task-archive"
                  data-archive-task={item.harnessRunId}
                  aria-label={`归档任务：${conversationTitle(item)}`}
                  title={
                    item.status === "running" ||
                    item.executions.some((execution) => !execution.finishedAt)
                      ? "处理中，结束后可归档"
                      : "归档任务"
                  }
                  disabled={
                    !!busyOperations[`task:${item.harnessRunId}`] ||
                    item.status === "running" ||
                    item.executions.some((execution) => !execution.finishedAt)
                  }
                  onClick={() => onArchive(item)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M3 4h14v3H3zM4 7v9h12V7M8 10h4" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      }
    </section>
  );
}
/** 仅由浏览器维护的新会话草稿；首次发送前不会创建 Harness、目录或 Journal。 */
function DraftConversation({
  project,
  text,
  onText,
  onSend,
  onTemplate,
  onLocal,
  pendingAttachments,
  onAddAttachments,
  onRemoveAttachment,
  attachmentBusy = false,
  attachmentError,
  onDismissAttachmentError,
}: {
  project: HarnessProject | null;
  text: string;
  onText: (value: string) => void;
  onSend: () => void;
  /** 打开预置来源；不创建任务。 */ onTemplate: () => void;
  /** 打开零执行的项目内本地Workflow预检。 */ onLocal?: () => void;
  /** 首条消息待发送的图片暂存描述；选择不发送。 */ pendingAttachments: import("./types").StagedAttachment[];
  /** 当前草稿正在选图/暂存，防止重复打开。 */ attachmentBusy?: boolean;
  /** 原草稿的选图错误，不随后台轮询清除。 */ attachmentError?: string | null;
  /** 仅关闭原草稿错误提示。 */ onDismissAttachmentError?: () => void;
  /** 打开已有系统图片选择器。 */ onAddAttachments: () => void;
  /** 仅移除尚未发送的指定附件。 */ onRemoveAttachment: (id: string) => void;
}) {
  const ready = project !== null;
  const attachmentButton = useRef<HTMLButtonElement>(null);
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let request = 0;
    setBranch(null);
    const refresh = () => {
      const token = ++request;
      if (project)
        void api
          .projectContext(project.projectId)
          .then((value) => {
            if (active && request === token)
              setBranch(
                value.branch ??
                  (value.status === "detached" ? "游离 HEAD" : null),
              );
          })
          .catch(() => {
            if (active && request === token) setBranch(null);
          });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [project?.projectId]);
  return (
    <div className="conversation draft-conversation">
      <div className="conversation-scroll">
        <div className="draft-welcome">
          <h2>
            {ready
              ? `你想在 ${project.title} 中完成什么？`
              : "选择一个项目，开始任务"}
          </h2>
          {!ready && <p>从左侧选择或创建本地项目。</p>}
        </div>
      </div>
      <div className="draft-input-region">
        <div
          className="draft-quick-actions"
          role="group"
          aria-label="任务快捷入口"
        >
          <span className="draft-project-name" title={project?.cwd}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M3 7V5h6l2 2h10v13H3zM3 10h18" />
            </svg>
            {project?.title ?? "未选择项目"}
          </span>
          {branch && (
            <span
              className="draft-project-branch"
              aria-label={`当前分支 ${branch}`}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="6" cy="5" r="2" />
                <circle cx="6" cy="19" r="2" />
                <circle cx="18" cy="5" r="2" />
                <path d="M6 7v10M18 7v3c0 4-12 0-12 6" />
              </svg>
              {branch}
            </span>
          )}
          <button
            data-workflow-source="template"
            type="button"
            className="draft-source-link"
            onClick={onTemplate}
            disabled={!ready}
          >
            预置工作流
          </button>
          <button
            data-workflow-source="local"
            type="button"
            className="draft-source-link"
            onClick={onLocal}
            disabled={!ready || !onLocal}
          >
            本地工作流
          </button>
        </div>
        <div className="conversation-composer">
          {attachmentError && (
            <div className="attachment-error" role="alert">
              <span>{attachmentError}</span>
              <button
                type="button"
                aria-label="关闭附件错误"
                onClick={() => {
                  onDismissAttachmentError?.();
                  requestAnimationFrame(() =>
                    attachmentButton.current?.focus(),
                  );
                }}
              >
                ×
              </button>
            </div>
          )}
          {pendingAttachments.length > 0 && (
            <ul className="pending-attachments" aria-label="待发送附件">
              {pendingAttachments.map((item) => (
                <li key={item.stagedId}>
                  {item.previewDataUrl && (
                    <img src={item.previewDataUrl} alt={item.name} />
                  )}
                  <span className="attachment-meta">
                    <strong>{item.name}</strong>
                    <small>待发送</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${item.name}`}
                    onClick={() => onRemoveAttachment(item.stagedId)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <AutoGrowTextarea
            autoFocus
            aria-label="描述任务目标"
            value={text}
            disabled={!ready}
            onChange={(event) => onText(event.target.value)}
            placeholder={ready ? "描述目标和要求…" : "请先选择项目"}
            onKeyDown={(event) => {
              if (shouldSubmitComposer(event)) {
                event.preventDefault();
                if (text.trim() && ready && !attachmentBusy) onSend();
              }
            }}
          />
          <div className="composer-footer">
            <div className="composer-guidance">
              <button
                ref={attachmentButton}
                type="button"
                className="add-attachment"
                aria-label="添加图片附件"
                title="添加图片附件（最多5张，选择后不会自动发送）"
                disabled={!ready || attachmentBusy}
                aria-busy={attachmentBusy}
                onClick={onAddAttachments}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M12 4v16M4 12h16" />
                </svg>
              </button>
              {attachmentBusy && <small role="status">正在添加图片…</small>}
              <small>⌘/Ctrl + Enter 发送 · Enter 换行</small>
            </div>
            <button
              className="send-message"
              aria-label="发送消息"
              disabled={!ready || !text.trim() || attachmentBusy}
              onClick={onSend}
            >
              ↑
            </button>
          </div>
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
  onSendImmediate,
  onCancelQueued,
  onRecover,
  pendingAttachments,
  onAddAttachments,
  onRemoveAttachment,
  attachmentBusy = false,
  attachmentError,
  onDismissAttachmentError,
  onAbort,
  onOpenWorkflow,
  hasWorkflow,
  onDraft,
  onTemplate,
  onRuntimeSettings,
  onRetryInitialization,
  onAccept,
  onReject,
  onAssignmentCreated,
  onSelectExecution,
  onSelectResults,
  onSelectRevision,
  onAdjustRevision,
  onAnswerDecision,
  onComplete,
  busy,
  lastEventAt,
  visible,
  onRead,
  draftContext,
}: {
  harness: HarnessSnapshot;
  text: string;
  onText: (value: string) => void;
  onSend: () => void;
  /** 立即发送：Engine 中断当前回合后优先投递。 */
  onSendImmediate: () => void;
  /** 取消尚未投递的排队消息。 */
  onCancelQueued: (messageId: string) => void;
  /** 恢复已中断主控到待命；不重发任务。 */
  onRecover: () => void;
  /** 待发送附件（Engine 暂存描述）；选择只创建暂存，不自动发送。 */
  pendingAttachments: import("./types").StagedAttachment[];
  /** 当前草稿正在选图/暂存；仅展示加载，不改变消息状态。 */ attachmentBusy?: boolean;
  /** 原草稿选图失败原因。 */ attachmentError?: string | null;
  /** 关闭当前草稿附件错误。 */ onDismissAttachmentError?: () => void;
  /** 打开系统文件选择并暂存所选图片。 */
  onAddAttachments: () => void;
  /** 移除一个待发送附件；不移除已发送消息的附件。 */
  onRemoveAttachment: (stagedId: string) => void;
  onAbort: () => void;
  onOpenWorkflow: () => void;
  hasWorkflow: boolean;
  onDraft: () => void;
  /** 用户显式选择预置工作流，不自动执行。 */ onTemplate: () => void;
  /** 自动检查失败后打开已有底座设置，不改变默认CLI。 */ onRuntimeSettings: () => void;
  /** 按原Task身份重试并更新权威快照；不重复创建任务。 */ onRetryInitialization: () => Promise<
    import("./types").HarnessRunResponse
  >;
  onAccept: (revision: number) => void;
  /** 拒绝草案；最新会话快照由调用方写回 state。 */
  onReject: (revision: number) => Promise<void>;
  onAssignmentCreated: (detail: ExecutionResponse) => void;
  onSelectExecution: (executionId: string, attempt?: number) => void;
  /** 打开原执行结果，不借用当前方案身份。 */ onSelectResults: (
    executionId: string,
  ) => void;
  onSelectRevision: (revision: import("./types").WorkflowRevision) => void;
  /** 只准备原版本修改上下文并聚焦输入，不发送消息。 */
  onAdjustRevision: (revision: import("./types").WorkflowRevision) => void;
  /** 输入草稿关联版本，不覆盖用户内容。 */ draftContext?: string;
  onAnswerDecision: (
    decisionId: string,
    answer: Record<string, unknown>,
  ) => Promise<void>;
  onComplete: () => void;
  busy: string | null;
  /** 最近一次条目事件到达时间（Date.now() 毫秒）；无事件时为 null。 */
  lastEventAt: number | null;
  /** 当前主控页可见性，隐藏页不能清未读。 */
  visible: boolean;
  /** 当前视口耐久身份阅读回调。 */
  onRead: (taskId: string, ids: string[]) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  useEffect(() => {
    if (!harness.diagnostic || harness.status === "running")
      setRetryError(null);
  }, [harness.harnessRunId, harness.diagnostic, harness.status]);
  return (
    <ConversationView
      key={harness.harnessRunId}
      harness={harness}
      draft={text}
      onDraft={onText}
      onSend={onSend}
      onSendImmediate={onSendImmediate}
      onCancelQueued={onCancelQueued}
      onRecover={onRecover}
      pendingAttachments={pendingAttachments}
      attachmentBusy={attachmentBusy}
      attachmentError={attachmentError}
      onDismissAttachmentError={onDismissAttachmentError}
      onAddAttachments={onAddAttachments}
      onRemoveAttachment={onRemoveAttachment}
      onAbort={onAbort}
      onComplete={onComplete}
      onOpenWorkflow={onOpenWorkflow}
      hasWorkflow={hasWorkflow}
      busy={busy}
      lastEventAt={lastEventAt}
      visible={visible}
      onRead={onRead}
      draftContext={draftContext}
      activity={
        <div className="task-activity-region">
          <TaskActivity
            task={harness}
            visible={visible}
            onPlan={onSelectRevision}
            onExecution={onSelectExecution}
            onResults={onSelectResults}
            onAdjust={onAdjustRevision}
            onTemplate={onTemplate}
          />
          {interruptedSummaryObligations(harness).map((item) => (
            <div className="task-summary-notice" key={item.key}>
              <ImpactSummaryPanel
                compact
                summaryKey={item.key}
                harness={harness}
                executionId={item.executionId}
                attempt={item.attempt}
              />
            </div>
          ))}
        </div>
      }
      timelineEvents={[
        ...harness.workflowRevisions.map((revision) => ({
          key: `revision:${revision.revision}`,
          at: revision.createdAt,
          planUpdate: planUpdateLabel(revision),
          content: (
            <p className="task-event">
              方案更新：{planUpdateLabel(revision)} ·{" "}
              <button onClick={() => onSelectRevision(revision)}>
                {proposalTitle(revision)}
              </button>
            </p>
          ),
        })),
        ...(harness.executionHistory?.length
          ? harness.executionHistory.flatMap((item) => {
              const execution = harness.executions.find(
                (execution) => execution.executionId === item.executionId,
              );
              const obligation =
                item.kind === "finished"
                  ? harness.impactSummaries?.find(
                      (summary) =>
                        summary.executionId === item.executionId &&
                        summary.attempt === item.attempt,
                    )
                  : undefined;
              const firstBody = obligation
                ? summaryBodyStartedAt(harness, obligation.key)
                : null;
              if (obligation && !firstBody) return [];
              const body = obligation
                ? harness.conversationEntries.find(
                    (entry) =>
                      entry.kind === "body" &&
                      entry.text.trim() &&
                      (entry.turnId === `summary:${obligation.key}` ||
                        entry.turnId.startsWith(`summary:${obligation.key}:`)),
                  )
                : undefined;
              return [
                {
                  key: item.key,
                  at: firstBody ?? item.at,
                  beforeTurnId: obligation
                    ? (body?.turnId ??
                      obligation.turnId ??
                      `summary:${obligation.key}`)
                    : undefined,
                  content: execution ? (
                    <WorkflowExecutionSummary
                      attempt={item.attempt}
                      execution={{
                        ...execution,
                        status: item.status,
                        diagnostic: item.diagnostic,
                        summary: item.summary,
                      }}
                      revision={harness.workflowRevisions.find(
                        (revision) => revision.revision === item.revision,
                      )}
                      onOpen={() =>
                        onSelectExecution(item.executionId, item.attempt)
                      }
                    />
                  ) : null,
                },
              ];
            })
          : harness.executions.map((execution) => ({
              key: `execution:${execution.executionId}`,
              at: execution.createdAt,
              content: (
                <WorkflowExecutionSummary
                  execution={execution}
                  revision={harness.workflowRevisions.find(
                    (revision) => revision.revision === execution.revision,
                  )}
                  onOpen={() => onSelectExecution(execution.executionId)}
                />
              ),
            }))),
      ]}
    >
      <div className="conversation-actions">
        {harness.task && harness.diagnostic?.includes("主控启动失败") && (
          <>
            <button
              disabled={retrying || !!busy}
              onClick={async () => {
                setRetrying(true);
                setRetryError(null);
                try {
                  const result = await onRetryInitialization();
                  if (result.harness.diagnostic)
                    setRetryError(result.harness.diagnostic);
                } catch (error) {
                  setRetryError(
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? "正在检查 CLI 并连接…" : "重试连接（不重复创建任务）"}
            </button>
            <button disabled={retrying} onClick={onRuntimeSettings}>
              执行环境设置
            </button>
          </>
        )}
      </div>
      {retrying && (
        <p role="status">正在检查当前 CLI，成功后继续原任务，不创建新任务。</p>
      )}
      {retryError && harness.status !== "running" && harness.diagnostic && (
        <p role="alert">{userFacingText(retryError)}</p>
      )}
      {harness.decisions
        .filter(
          (decision) =>
            decision.answer === null && harness.status === "running",
        )
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
      <span>Wave Flow 需要你的决定</span>
      <p>{decision.question}</p>
      {decision.answerSchema ? (
        <SchemaForm
          schema={decision.answerSchema}
          busy={busy}
          submitLabel="提交决定"
          onSubmit={onAnswer}
        />
      ) : (
        <FreeJsonAnswer
          busy={busy}
          submitLabel="提交决定"
          onSubmit={onAnswer}
        />
      )}
    </article>
  );
}

/** 原 attempt 的只读证据；切换或迟到响应不污染其他任务。 */
function ArchiveTaskConfirmation({
  task,
  onClose,
  onConfirm,
}: {
  task: HarnessSnapshot;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const count =
    task.impactSummaries?.filter(
      (item) => !item.supersededBy && item.status !== "completed",
    ).length ?? 0;
  useEffect(() => {
    const previous =
      [
        ...document.querySelectorAll<HTMLButtonElement>("[data-archive-task]"),
      ].find((item) => item.dataset.archiveTask === task.harnessRunId) ??
      (document.activeElement as HTMLElement | null);
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        ".agent-workbench > :not(.archive-backdrop)",
      ),
    ];
    const original = background.map((item) => item.inert);
    background.forEach((item) => (item.inert = true));
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      background.forEach((item, index) => (item.inert = original[index]!));
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, []);
  return (
    <div
      className="connection-backdrop archive-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="connection-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-task-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const buttons =
              dialog.current?.querySelectorAll<HTMLButtonElement>("button");
            if (!buttons?.length) return;
            const first = buttons[0]!,
              last = buttons[buttons.length - 1]!;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="connection-panel-head">
          <h2 id="archive-task-title">仍有未完成总结</h2>
        </div>
        <div className="connection-form">
          <strong>{conversationTitle(task)}</strong>
          <p>
            仍有 {count}{" "}
            份执行总结未完成。你可以返回处理，或明确放弃总结并归档。归档后可在“已完成”中查看历史，不能继续执行。
          </p>
        </div>
        <div className="modal-actions">
          <button className="button-secondary" onClick={onClose}>
            返回处理
          </button>
          <button className="button-danger" onClick={onConfirm}>
            放弃总结并归档
          </button>
        </div>
      </section>
    </div>
  );
}
function ArchiveImpactConfirmation({
  count,
  onClose,
  onConfirm,
}: {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous =
      document.querySelector<HTMLButtonElement>("[data-archive-task]") ??
      (document.activeElement as HTMLElement | null);
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="connection-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-impact-title"
        className="connection-panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const buttons =
              dialog.current?.querySelectorAll<HTMLButtonElement>("button");
            if (!buttons?.length) return;
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="connection-panel-head">
          <h2 id="archive-impact-title">放弃总结并归档？</h2>
        </div>
        <div className="connection-form">
          <p>
            仍有 {count}{" "}
            份执行总结未完成。归档后任务只读，不能再启动或恢复执行；未完成影响会保留在历史中。
          </p>
        </div>
        <div className="modal-actions">
          <button className="button-secondary" onClick={onClose}>
            返回处理
          </button>
          <button className="button-danger" onClick={onConfirm}>
            明确放弃并归档
          </button>
        </div>
      </section>
    </div>
  );
}

/** 原 attempt 的只读证据；切换或迟到响应不污染其他任务。 */
function HistoricalResults({
  taskId,
  executionId,
  currentAttempt,
  selectedAttempt,
  onSelectAttempt,
  harness,
}: {
  taskId: string;
  executionId: string;
  currentAttempt: number;
  /** 路由指定的历史尝试，缺省跟随最新。 */ selectedAttempt?: number;
  /** 更新阅读路由，不启动执行。 */ onSelectAttempt: (attempt: number) => void;
  harness: HarnessSnapshot;
}) {
  const attempt = readingAttempt(selectedAttempt, currentAttempt);
  const resultIdentity = `${taskId}:${executionId}:${attempt}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: Awaited<ReturnType<typeof api.attemptResults>>;
  } | null>(null);
  const value = loaded?.identity === resultIdentity ? loaded.value : null;
  const [error, setError] = useState<string | null>(null);
  const terminalVersion = harness.executions.find(
    (item) => item.executionId === executionId,
  )?.finishedAt;
  useEffect(() => {
    let active = true;
    setLoaded(null);
    setError(null);
    void api
      .attemptResults(taskId, executionId, attempt)
      .then((value) => {
        if (active) setLoaded({ identity: resultIdentity, value });
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [taskId, executionId, attempt, terminalVersion]);
  return (
    <section className="workflow-results">
      <h2>执行结果</h2>
      <p>查看已保存的总结与交付，不会重新执行。执行结束不等于目标已验收。</p>
      <PreviousRecords
        part="notice"
        current={currentAttempt}
        selected={attempt}
        onSelect={onSelectAttempt}
        records={[]}
      />
      {value && (
        <p role="status">
          {value.status
            ? ((
                {
                  completed: "执行结束",
                  cancelled: "已停止",
                  interrupted: "已中断",
                  running: "执行中",
                  paused: "已暂停",
                  pausing: "正在暂停",
                  recovering: "正在恢复",
                } as Record<string, string>
              )[value.status] ?? value.status)
            : "未保存结束状态"}
        </p>
      )}
      <ImpactSummaryPanel
        harness={harness}
        executionId={executionId}
        attempt={attempt}
      />
      {error && <p role="alert">{userFacingText(error)}</p>}
      {!value && !error && <p>正在读取结果…</p>}
      {value && (
        <>
          <h2>节点结果</h2>
          {value.nodes.length === 0 && <p>这份记录没有已完成节点。</p>}
          {value.nodes.map((node) => (
            <PersistedDetails
              identity={`${taskId}:${executionId}:${attempt}:${node.id}:result`}
              key={node.id}
            >
              <summary>{node.label}</summary>
              <pre>{JSON.stringify(node.result, null, 2)}</pre>
            </PersistedDetails>
          ))}
          <details className="execution-diagnostics">
            <summary>高级 / 诊断信息 · 原始返回 JSON</summary>
            {value.summary ? (
              <pre>{JSON.stringify(value.summary, null, 2)}</pre>
            ) : (
              <p>这份记录未保存工作流返回结果。</p>
            )}
          </details>
        </>
      )}
      <PreviousRecords
        part="list"
        current={currentAttempt}
        selected={attempt}
        onSelect={onSelectAttempt}
        records={(harness.executionHistory ?? [])
          .filter(
            (item) =>
              item.executionId === executionId && item.kind === "finished",
          )
          .map((item) => ({
            id: item.attempt ?? 1,
            at: item.at,
            status: item.status,
          }))}
      />
    </section>
  );
}

/** 义务与完整回答均来自原Task快照；重试不重跑业务执行。 */
function ImpactSummaryPanel({
  harness,
  executionId,
  attempt,
  summaryKey,
  compact = false,
}: {
  harness: HarnessSnapshot;
  executionId: string;
  attempt: number;
  summaryKey?: string;
  compact?: boolean;
}) {
  const summaries =
    harness.impactSummaries?.filter(
      (item) => item.executionId === executionId && item.attempt === attempt,
    ) ?? [];
  const obligation = summaryKey
    ? summaries.find((item) => item.key === summaryKey)
    : summaries[0];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  if (!obligation) return <p>此执行未保存总结；请查看下方已保存的结果。</p>;
  if (compact)
    return (
      <div className="summary-compact">
        <span>
          {summaryWorkLabel(harness, executionId)}
          ：总结未完成，暂不能启动或恢复执行。
        </span>
        <button
          disabled={
            busy ||
            harness.status === "running" ||
            harness.status === "completed"
          }
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.retryImpactSummary(
                harness.harnessRunId,
                obligation.key,
              );
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "正在重试…" : "重试总结"}
        </button>
        <small>不会重新执行工作流</small>
        <details>
          <summary>查看原因</summary>
          <p>{userFacingText(obligation.diagnostic ?? "总结回合已中断。")}</p>
        </details>
        {error && <p role="alert">{userFacingText(error)}</p>}
      </div>
    );
  if (!summaryKey)
    return (
      <section aria-label="原总结与补充">
        {summaries.map((item) => (
          <div key={item.key}>
            {item.supplementOf && <h3>现场变化补充</h3>}
            <ImpactSummaryPanel
              harness={harness}
              executionId={executionId}
              attempt={attempt}
              summaryKey={item.key}
            />
          </div>
        ))}
        {error && <p role="alert">{error}</p>}
        {harness.status !== "completed" && (
          <button
            disabled={
              busy ||
              harness.status !== "idle" ||
              harness.executions.some((item) => item.finishedAt === null)
            }
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.checkExecutionScene(
                  harness.harnessRunId,
                  executionId,
                );
              } catch (error) {
                setError(String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "正在检查…" : "检查项目现状（不会执行）"}
          </button>
        )}
      </section>
    );
  if (obligation.supersededBy)
    return (
      <p>
        此补充已被更新的检查结果替代；保留历史，不再阻塞恢复。请查看最新补充。
      </p>
    );
  if (
    obligation.supplementOf &&
    obligation.status === "interrupted" &&
    harness.status !== "completed"
  )
    return (
      <section>
        <p role="alert">
          {userFacingText(obligation.diagnostic ?? "补充检查已中断")}
        </p>
        {error && <p role="alert">{userFacingText(error)}</p>}
        <button
          disabled={busy || harness.status === "running"}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const checked = await api.checkExecutionScene(
                harness.harnessRunId,
                executionId,
              );
              const current = checked.harness.impactSummaries?.find(
                (item) =>
                  item.executionId === executionId &&
                  !item.supersededBy &&
                  item.status === "interrupted",
              );
              if (current)
                await api.retryImpactSummary(harness.harnessRunId, current.key);
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          重新检查并重试补充
        </button>
      </section>
    );
  const message = harness.messages.find(
    (item) => item.id === obligation.messageId,
  );
  const gitLimitation = harness.executions.find(
    (item) => item.executionId === executionId,
  )?.config?.workspaces
    ? "受管Git证据仅覆盖受管Git文件；缺失或不可读取的记录不代表没有改动，也不证明已合入主工作区或外部系统已回滚。"
    : "尚无Git起止基线，不能证明文件归因、完整diff或外部副作用。";
  if (obligation.status === "cancelled")
    return (
      <article aria-label="执行总结">
        <h2>执行总结</h2>
        <p>用户已放弃总结并只读归档；总结未完成，不再开放执行。</p>
      </article>
    );
  return (
    <article aria-label="执行总结">
      <h2>执行总结</h2>
      <p role="status">
        {
          {
            pending: "准备总结",
            running: "正在总结",
            interrupted: "总结中断，须重试",
            completed: "总结已保存",
          }[obligation.status]
        }
      </p>
      {obligation.status !== "completed" && (
        <p>
          完整总结前不能启动或恢复执行；可继续查看结果与反馈。重试只生成总结，不会重新执行节点。
        </p>
      )}
      {obligation.diagnostic && (
        <p role="alert">{userFacingText(obligation.diagnostic)}</p>
      )}
      {error && <p role="alert">{userFacingText(error)}</p>}
      {obligation.status === "completed" && message && (
        <MessageBody text={message.text} />
      )}
      <details className="summary-evidence-limits">
        <summary>证据范围与限制</summary>
        <p>{gitLimitation}</p>
      </details>
      {harness.status !== "completed" && obligation.status !== "completed" && (
        <button
          disabled={
            busy ||
            (obligation.status === "running" && !obligation.turnId) ||
            (harness.status === "running" && obligation.status !== "running")
          }
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              if (obligation.status === "running")
                await api.stopImpactSummary(
                  harness.harnessRunId,
                  obligation.key,
                  obligation.turnId!,
                );
              else
                await api.retryImpactSummary(
                  harness.harnessRunId,
                  obligation.key,
                );
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "正在处理…"
            : obligation.status === "running"
              ? "停止总结"
              : "重试总结"}
        </button>
      )}
    </article>
  );
}

function ExecutionDetail({
  previousRecords = [],
  readOnly = false,
  detail,
  selectedAttempt,
  onSelectAttempt,
  busy,
  dynamicCount,
  harnessRunId,
  theme,
  onControl,
  onAnswer,
  onAnswerBlock,
  onSavePartial,
  onCleanupWorkspaces,
}: {
  /** 原终态记录时间和状态；与结果页同源，缺失不按阶段时间推断。 */
  previousRecords?: readonly { id: number; at?: string; status?: string }[];
  /** 归档或旧Execution只读，隐藏所有副作用入口；diff与历史证据仍可读。 */
  readOnly?: boolean;
  detail: ExecutionResponse;
  busy: string | null;
  /** 该 revision 静态无法枚举的动态节点数；0 表示无动态节点或不可用。 */
  dynamicCount: number;
  /** 所属 Harness Run id；用于跨 attempt 读取耐久 Phase 访问（复用分组）。 */
  harnessRunId: string;
  /** 当前应用主题，驱动变更面板 diff 配色。 */
  theme: ColorTheme;
  onControl: (action: "pause" | "recover" | "stop" | "resume") => Promise<void>;
  onAnswer: (gateId: string, answer: Record<string, unknown>) => Promise<void>;
  onAnswerBlock: (
    blockId: string,
    answer: Record<string, unknown>,
  ) => Promise<void>;
  /** 显式保存停止现场，不恢复业务；只有当前Engine可核验writer才成功。 */
  onSavePartial?: () => Promise<void>;
  /** 清理安全checkout，不删除分支commit或业务证据。 */
  onCleanupWorkspaces?: () => Promise<void>;
  /** 阅读指定耐久 attempt；缺省显示当前执行，不改变业务状态。 */
  selectedAttempt?: number;
  /** 只更新阅读路由，不恢复或派发。 */
  onSelectAttempt?: (attempt: number) => void;
}) {
  const executionId = detail.execution.executionId;
  const [allVisits, setAllVisits] = useState<PhaseVisit[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(true);
  const [visitsError, setVisitsError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
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
    setVisitsLoading(true);
    setVisitsError(null);
    setAllVisits([]);
    void loadAllVisits()
      .then((items) => {
        if (active) setAllVisits(items);
      })
      .catch((error) => {
        if (active)
          setVisitsError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (active) setVisitsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    loadAllVisits,
    detail.snapshot.currentExecutionAttemptId,
    detail.snapshot.status,
  ]);
  // attempt由执行计数登记，不以Phase访问存在推断；早期取消也有合法尝试。
  const attemptIds = Array.from(
    { length: detail.snapshot.currentExecutionAttemptId },
    (_, index) => index + 1,
  );
  const readingAttempt =
    selectedAttempt ?? detail.snapshot.currentExecutionAttemptId;
  const historical =
    readingAttempt !== detail.snapshot.currentExecutionAttemptId;
  if (selectedAttempt && !attemptIds.includes(selectedAttempt))
    return (
      <p role="alert">所选执行尝试不存在或尚未读取，请选择当前执行查看。</p>
    );
  return (
    <>
      <PreviousRecords
        part="notice"
        current={detail.snapshot.currentExecutionAttemptId}
        selected={readingAttempt}
        onSelect={(id) => onSelectAttempt?.(id)}
        records={[]}
      />
      {detail.workspaceDiagnostic && (
        <p role="alert">{userFacingText(detail.workspaceDiagnostic)}</p>
      )}
      {detail.sourceDiagnostic && (
        <p role="alert">
          改动还没有整理好：{userFacingText(detail.sourceDiagnostic)}
        </p>
      )}
      {!readOnly &&
        !historical &&
        detail.snapshot.status === "completed" &&
        detail.execution.config?.workspaces &&
        (!detail.sourceEvidence || detail.sourceDiagnostic) && (
          <button disabled={!!busy} onClick={() => void onControl("resume")}>
            重新整理改动（不会重新执行）
          </button>
        )}
      {detail.sourceEvidence && (
        <button disabled={!!busy} onClick={() => setChangesOpen(true)}>
          查看变更
        </button>
      )}
      {detail.sourceEvidence && changesOpen && (
        <ChangesPanel
          key={`${harnessRunId}:${executionId}:${detail.sourceEvidence.sourceCommit}`}
          taskId={harnessRunId}
          executionId={executionId}
          sourceCommit={detail.sourceEvidence.sourceCommit}
          writable={!readOnly && Boolean(onCleanupWorkspaces) && !historical}
          theme={theme}
          onClose={() => setChangesOpen(false)}
        />
      )}
      {partialError && <p role="alert">{partialError}</p>}
      {!readOnly &&
        !historical &&
        detail.workspaceEvidence?.some((item) => item.lease) &&
        ["cancelled", "interrupted"].includes(detail.snapshot.status) && (
          <>
            <button
              disabled={!!busy}
              onClick={() => {
                setPartialError(null);
                void onSavePartial?.().catch((error) =>
                  setPartialError(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
              }}
            >
              保存当前改动（未交付）
            </button>
            {partialError && <p role="alert">{partialError}</p>}
          </>
        )}
      {!readOnly &&
        !historical &&
        detail.workspaceEvidence?.length &&
        !detail.controllable && (
          <>
            <button
              disabled={!!busy}
              onClick={() => {
                if (!confirmCleanup) {
                  setConfirmCleanup(true);
                  return;
                }
                setPartialError(null);
                void onCleanupWorkspaces?.()
                  .then(() => setConfirmCleanup(false))
                  .catch((error) =>
                    setPartialError(
                      error instanceof Error ? error.message : String(error),
                    ),
                  );
              }}
            >
              {confirmCleanup
                ? "确认清理临时工作区？改动提交已保留，不受影响"
                : "清理临时工作区"}
            </button>
            {confirmCleanup && (
              <button onClick={() => setConfirmCleanup(false)}>取消清理</button>
            )}
            {partialError && <p role="alert">{partialError}</p>}
          </>
        )}
      {historical ? (
        <>
          <p>历史过程，只读；此页面不会恢复执行。</p>
          {visitsLoading ? (
            <p role="status">正在读取历史过程…</p>
          ) : visitsError ? (
            <p role="alert">
              历史过程暂时无法读取：{visitsError}。可切到结果查看已保存的交付。
            </p>
          ) : allVisits.some(
              (visit) => visit.executionAttemptId === readingAttempt,
            ) ? (
            <TeamPanel
              readOnly
              key={`${executionId}:${readingAttempt}`}
              runId={executionId}
              currentExecutionAttemptId={readingAttempt}
              phaseTitles={detail.snapshot.phases.map((phase) => phase.title)}
              visits={allVisits.filter(
                (visit) => visit.executionAttemptId === readingAttempt,
              )}
              busy={null}
              onAnswer={async () => {
                throw new Error("历史 attempt 不能回答。");
              }}
            />
          ) : (
            <p>
              此尝试未保存阶段过程记录，不代表没有执行。可切到结果查看原终态与交付。
            </p>
          )}
        </>
      ) : (
        <>
          <ExecutionProgressCard
            snapshot={detail.snapshot}
            dynamicCount={dynamicCount}
            plannedTotal={detail.execution.config?.assignments.length}
            allVisits={allVisits}
          />
          <div className="execution-summary">
            <span>方案 v{detail.execution.revision}（已锁定）</span>
            {detail.execution.config && (
              <small>
                分配：{detail.execution.config.assignments.length} 名执行者
                {detail.execution.config.ruleText
                  ? ` · 规则“${detail.execution.config.ruleText}”${detail.execution.config.ruleDegraded ? "（解析失败，已退化为随机分配）" : ""}`
                  : ""}
              </small>
            )}
            <ExecutionDiagnostics
              executionId={detail.execution.executionId}
              sourceHash={detail.execution.sourceHash}
              runtimeVersion={detail.execution.runtimeVersion}
              currentAttempt={detail.snapshot.currentExecutionAttemptId}
              fallbackRuntimeId={
                detail.execution.config?.fallbackRuntimeId ?? null
              }
            />
          </div>
          {detail.workspaceEvidence && (
            <details className="execution-workspace-evidence">
              <summary>高级 / 诊断 · 内部 Git 检查点</summary>
              {detail.workspaceEvidence.map((item) => (
                <article key={item.nodeId}>
                  <strong>{item.nodeId}</strong>
                  <code>{item.branch}</code>
                  {item.lease && (
                    <span role="status">
                      writer / Git 收尾锁仍保留 · attempt #{item.lease.attempt}
                    </span>
                  )}
                  {item.results.length === 0 && !item.lease && (
                    <small>尚无保存成果</small>
                  )}
                  {item.results.map((result) => (
                    <div key={`${result.attempt}:${result.commit}`}>
                      <span>
                        {result.ready ? "成果 ready" : "partial，未交付"} ·
                        attempt #{result.attempt}
                        {result.unchanged ? " · 无文件变化" : ""}
                      </span>
                      <code title={result.commit}>
                        {result.commit.slice(0, 12)}
                      </code>
                      <small>
                        {result.paths.length
                          ? result.paths.join("、")
                          : "没有提交文件"}
                        {result.mergeParents.length
                          ? ` · 集成 ${result.mergeParents.length} 个来源`
                          : " · 未集成其他分支"}
                      </small>
                    </div>
                  ))}
                </article>
              ))}
              <p>
                Git 证据只覆盖受管Git文件与已执行验证，不证明外部系统已回滚。
              </p>
            </details>
          )}
          {!readOnly && (
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
              {(detail.snapshot.status === "interrupted" ||
                detail.snapshot.status === "cancelled" ||
                (!detail.controllable &&
                  detail.snapshot.status !== "completed")) && (
                <Action
                  label={
                    detail.snapshot.status === "cancelled"
                      ? "恢复已停止 Execution"
                      : "恢复中断 Execution"
                  }
                  icon="↻"
                  tone="primary"
                  loading={busy === "execution:resume"}
                  onClick={() => void onControl("resume")}
                />
              )}
              {detail.controllable &&
                ["running", "pausing", "recovering", "paused"].includes(
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
          )}
          {!readOnly &&
            !detail.controllable &&
            detail.snapshot.status !== "completed" &&
            detail.snapshot.status !== "interrupted" &&
            detail.snapshot.status !== "cancelled" && (
              <div className="diagnostic">
                该 Execution 不在当前 Engine 的可控制生命周期内（Engine
                已重启）；只能显式 resume 创建新 attempt，pause/stop
                与决策门回答都会被拒绝。
              </div>
            )}
          {detail.snapshot.diagnostic && (
            <div className="diagnostic">
              {userFacingText(detail.snapshot.diagnostic)}
            </div>
          )}
          {detail.snapshot.gates
            .filter(
              (gate) =>
                gate.answer === null &&
                detail.controllable &&
                detail.snapshot.status === "running",
            )
            .map((gate) => (
              <GateCard
                key={gate.gateId}
                gate={gate}
                busy={busy === `gate:${gate.gateId}`}
                onAnswer={(answer) => onAnswer(gate.gateId, answer)}
              />
            ))}
          <TeamPanel
            readOnly={
              !detail.controllable || terminal.has(detail.snapshot.status)
            }
            runId={detail.execution.executionId}
            currentExecutionAttemptId={
              detail.snapshot.currentExecutionAttemptId
            }
            phaseTitles={detail.snapshot.phases.map((phase) => phase.title)}
            visits={detail.snapshot.phaseVisits}
            fallbackPhases={detail.snapshot.phases}
            busy={busy}
            onAnswer={onAnswerBlock}
            loadAllVisits={loadAllVisits}
            waitingVisitId={
              detail.snapshot.gates.find(
                (gate) =>
                  gate.answer === null &&
                  gate.executionAttemptId ===
                    detail.snapshot.currentExecutionAttemptId,
              )?.phaseVisitId ?? undefined
            }
          />
        </>
      )}
      <PreviousRecords
        part="list"
        current={detail.snapshot.currentExecutionAttemptId}
        selected={readingAttempt}
        onSelect={(id) => onSelectAttempt?.(id)}
        records={previousRecords}
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
        <FreeJsonAnswer
          busy={busy}
          submitLabel="提交答案"
          onSubmit={onAnswer}
        />
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
    harness.task?.title ||
    harness.messages
      .find((message) => message.role === "user")
      ?.text.slice(0, 28) ||
    harness.cwd.split("/").filter(Boolean).at(-1) ||
    "新任务"
  );
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
import { ChangesPanel } from "./changes-panel";
