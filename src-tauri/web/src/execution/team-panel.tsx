import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentSnapshot, PhaseVisit, RunSnapshot } from "../types";
import { computeReusedAgents, type ReusedAgentGroup } from "./reused-agents";
import { SchemaForm } from "../forms/schema-form";
import { ViewCache } from "../workbench-state";
import {PersistedDetails} from "../persisted-details";
import { userFacingText } from "../user-facing-text";
import { cliDisplayName } from "../cli-meta";
import { statusLabel } from "./status-label";
const agentExpansion=new ViewCache<boolean>(256);
const AnswerAllowed=createContext(true);

/** 节点状态文案（与工作台既有措辞一致）。 */

/** 非终态集合：用于从耐久数据判定一次 phaseVisit 是否仍在进行。 */
const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "blocked",
  "pausing",
  "paused",
  "recovering",
]);

/** 由 Agent id 生成稳定 identicon：hash 决定色相与两个几何块，不依赖渲染顺序。 */
function Identicon({ seed }: { seed: string }) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const inner = (hash >> 9) % 2 === 0;
  return (
    <svg className="wf-identicon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="7" fill={`hsl(${hue} 45% 38%)`} />
      {inner ? (
        <circle cx="12" cy="12" r="5" fill={`hsl(${(hue + 40) % 360} 70% 72%)`} />
      ) : (
        <rect x="7" y="7" width="10" height="10" rx="3" fill={`hsl(${(hue + 40) % 360} 70% 72%)`} />
      )}
    </svg>
  );
}

/** Worker block 答题：单行 JSON 对象输入，提交载荷与既有裸 JSON 行为一致。 */
function BlockAnswerForm({
  blockRequestId,
  busy,
  onAnswer,
  schema,
}: {
  /** 阻塞请求 id；答案只唤醒原命令。 */
  blockRequestId: string;
  /** 是否正在交付。 */
  busy: boolean;
  /** 交付回调（api.answer）。 */
  onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
  /** 原Worker答案Schema，不从自然语言猜测。 */
  schema?:Record<string,unknown>;
}) {
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  if(schema)return <SchemaForm schema={schema} busy={busy} submitLabel="交付答案" onSubmit={answer=>onAnswer(blockRequestId,answer)} />;
  async function submit() {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error("答案必须是 JSON 对象。 ");
      setError(null);
      await onAnswer(blockRequestId, parsed as Record<string, unknown>);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <div className="wf-block-answer">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        placeholder='{"key": "value"}'
        aria-label="答案 JSON"
      />
      <button disabled={busy} onClick={() => void submit()}>
        {busy ? "正在交付…" : "交付答案"}
      </button>
      {error && <span className="answer-error">{error}</span>}
    </div>
  );
}

/** 截断超长 JSON 文本，避免结构化结果撑爆面板。 */
function truncate(text: string, limit = 2000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

/** 单个 Agent 行：identicon + 名称 + 状态 + CLI；点击展开内联详情（不用弹窗）。 */
function AgentRow({
  agent,
  runId,
  executionAttemptId,
  phaseVisitId,
  busy,
  onAnswer,
}: {
  /** 节点权威快照。 */
  agent: AgentSnapshot;
  /** 所属 Run/Execution id（诊断信息）。 */
  runId: string;
  /** 所属执行尝试序号（诊断信息）。 */
  executionAttemptId: number;
  /** 所属 Phase 访问 id；快照回落模式下为 null。 */
  phaseVisitId: number | null;
  /** 面板级 busy 标识。 */
  busy: string | null;
  /** Worker block 答题回调。 */
  onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
}) {
  const viewKey=`${runId}:${executionAttemptId}:${phaseVisitId??"reused"}:${agent.id}`;
  const [open, setOpen] = useState(()=>agentExpansion.get(viewKey)??false);
  const answerAllowed=useContext(AnswerAllowed);
  const paused = ["pausing", "paused", "recovering"].includes(agent.status);
  return (
    <div className={`wf-agent-row ${agent.status}`}>
      <button
        type="button"
        className="wf-agent-row-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => {agentExpansion.set(viewKey,!current);return !current;})}
      >
        <Identicon seed={agent.id} />
        <span className="wf-agent-name">{agent.label}</span>
        <span className="wf-agent-cli">
          {cliDisplayName(agent.cli)}
        </span>
        <em className={`wf-agent-status ${agent.status}`}>{statusLabel(agent.status)}</em>
      </button>
      {/* 停滞提示只补充可见性：不改变状态徽标、不进入错误态，也不阻断答题。 */}
      {agent.hint && (
        <p className="wf-agent-hint" role="status">
          {userFacingText(agent.hint)}
        </p>
      )}
      {open && (
        <div className="wf-agent-detail">
          {agent.diagnostic && (
            <div className="wf-agent-line">
              <span>最新汇报</span>
              <p>{userFacingText(agent.diagnostic)}</p>
            </div>
          )}
          {agent.result && (
            <div className="wf-agent-line">
              <span>结构化结果</span>
              <pre>{truncate(JSON.stringify(agent.result, null, 2))}</pre>
            </div>
          )}
          {agent.block && (
            <div className="wf-agent-line">
              <span>需要你的输入</span>
              <p>{agent.block.needHelp}</p>
              {!answerAllowed ? <p className="wf-agent-note">历史记录只读，不能交付答案。</p> : paused ? (
                <p className="wf-agent-note">暂停中。恢复后才能交付答案。</p>
              ) : agent.block.answered ? (
                <p className="wf-agent-note">答案已提交，等待继续。</p>
              ) : (
                <BlockAnswerForm
                  blockRequestId={agent.block.blockRequestId}
                  schema={agent.block.answerSchema}
                  busy={busy === `answer:${agent.block.blockRequestId}`}
                  onAnswer={onAnswer}
                />
              )}
            </div>
          )}
          <PersistedDetails identity={`${viewKey}:diagnostic`} className="wf-agent-diag">
            <summary>诊断</summary>
            <dl>
              <dt>runId</dt>
              <dd>{runId}</dd>
              <dt>attempt</dt>
              <dd>#{executionAttemptId}</dd>
              {phaseVisitId !== null && (
                <>
                  <dt>phaseVisitId</dt>
                  <dd>{phaseVisitId}</dd>
                </>
              )}
              <dt>agentId</dt>
              <dd>{agent.id}</dd>
              {agent.request?.assignedRuntimeId && (
                <>
                  <dt>assignedRuntimeId</dt>
                  <dd>{agent.request.assignedRuntimeId}</dd>
                </>
              )}
              <dt>cwd</dt>
              <dd>{agent.cwd}</dd>
            </dl>
          </PersistedDetails>
        </div>
      )}
    </div>
  );
}

/** 一次 Phase 访问内的批次：并行且多 Agent 时展示泳道，单 Agent 批次不显示冗余批次标题。 */
function VisitBatches({
  visit,
  batches,
  runId,
  busy,
  onAnswer,
}: {
  /** 访问元信息；快照回落模式下为 null。 */
  visit: PhaseVisit | null;
  /** 本访问的耐久批次。 */
  batches: PhaseVisit["batches"];
  runId: string;
  busy: string | null;
  onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
}) {
  const attemptId = visit?.executionAttemptId ?? 0;
  return (
    <div className="wf-batch-list">
      {batches.map((batch) => {
        const parallel = batch.mode === "parallel" && batch.agents.length > 1;
        return (
          <div className={`wf-batch ${parallel ? "parallel" : ""}`} key={batch.sequence}>
            {parallel && (
              <div className="wf-batch-head">并行批次 · {batch.agents.length} 名 Agent</div>
            )}
            <div className={parallel ? "wf-lanes" : undefined}>
              {batch.agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  runId={runId}
                  executionAttemptId={attemptId}
                  phaseVisitId={visit?.phaseVisitId ?? null}
                  busy={busy}
                  onAnswer={onAnswer}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 一次 Phase 执行的时间线条目状态。 */
type VisitStatus = "进行中" | "已完成" | "未开始";

/** 历史执行已完成、本次复用原结果的节点组（只读展示，标清来源）。 */
function ReusedBlock({
  group,
  runId,
  busy,
  onAnswer,
}: {
  /** 复用分组（来源 attempt/occurrence + completed 节点）。 */
  group: ReusedAgentGroup;
  runId: string;
  busy: string | null;
  onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <div className="wf-reused-block">
      <div className="wf-reused-head">
        复用第 {group.sourceOccurrence} 次执行的结果
      </div>
      {group.agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          runId={runId}
          executionAttemptId={group.sourceAttemptId}
          phaseVisitId={null}
          busy={busy}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

/**
 * 团队面板：单一 Phase 轨迹视图。Phase 按 meta 声明顺序，访问按实际进入事件排序。
 * 数据源优先级：调用方传入的快照内嵌 phaseVisits（Lead Execution 与独立 Run 的
 * RunSnapshot 均内嵌当前 attempt 耐久访问，含回访轮次）→ 独立 RunListItem 无内嵌快照时
 * 经 runs.phaseVisits 翻页读取 → API 不可用时回落到快照内嵌批次。
 * 绝不从卡片位置或完成时间推断箭头/DAG。
 */
export function TeamPanel({
  runId,
  currentExecutionAttemptId,
  phaseTitles,
  visits: embeddedVisits,
  fallbackPhases,
  busy,
  onAnswer,
  loadAllVisits,
  waitingVisitId,
  readOnly=false,
}: {
  /** Run id（独立 Run）或 Execution id（Lead Execution）。 */
  runId: string;
  /** 当前执行尝试序号；phaseVisit 只在该 attempt 内取数。 */
  currentExecutionAttemptId: number;
  /** 按 meta 声明顺序的 Phase 标题（未访问占位与快照回落）。 */
  phaseTitles: string[];
  /** 快照内嵌的当前 attempt 阶段访问（含 occurrence 回访轮次）；提供时不发任何请求。 */
  visits?: PhaseVisit[];
  /** 快照回落模式使用的内嵌批次（API 不可用时的兜底）。 */
  fallbackPhases?: RunSnapshot["phases"];
  /** 面板级 busy 标识。 */
  busy: string | null;
  /** Worker block 答题回调。 */
  onAnswer: (blockId: string, answer: Record<string, unknown>) => Promise<void>;
  /**
   * 可选：读取全部 attempt 的耐久 Phase 访问（Lead Execution 专用通道）。
   * 提供时面板为每个 Phase 补齐"历史执行已完成、本次复用原结果"的节点组，
   * 否则只展示当前 attempt 视野（独立 Run 现状）。
   */
  loadAllVisits?: () => Promise<PhaseVisit[]>;
  /** 当前 attempt 未回答脚本 gate 所属访问；不从自然语言猜等待状态。 */
  waitingVisitId?: number;
  /** 历史或已封存执行只读，不渲染Worker提交表单。 */
  readOnly?:boolean;
}) {
  const attemptId = currentExecutionAttemptId;
  const [fetchedVisits, setFetchedVisits] = useState<PhaseVisit[] | null>(null);
  const [visitsFailed, setVisitsFailed] = useState(false);
  const [allVisits, setAllVisits] = useState<PhaseVisit[] | null>(null);
  useEffect(() => {
    if (!loadAllVisits) return;
    let active = true;
    setAllVisits(null);
    loadAllVisits()
      .then((value) => {
        if (active) setAllVisits(value);
      })
      .catch(() => {
        // 跨 attempt 读取失败只丢失复用分组，当前 attempt 视野不受影响。
        if (active) setAllVisits(null);
      });
    return () => {
      active = false;
    };
  }, [loadAllVisits, attemptId]);
  useEffect(() => {
    if (embeddedVisits) return;
    let active = true;
    setFetchedVisits(null);
    setVisitsFailed(false);
    const load = async () => {
      const items: PhaseVisit[] = [];
      let cursor: number | null = null;
      // 顺序翻页直到读完当前 attempt 的耐久访问记录（上限防止异常循环）。
      for (let page = 0; page < 10; page += 1) {
        const response = await api.phaseVisits(
          runId,
          cursor === null ? { attempt: attemptId } : { attempt: attemptId, cursor },
        );
        items.push(...response.items);
        cursor = response.nextCursor;
        if (cursor === null) break;
      }
      if (active) setFetchedVisits(items);
    };
    load().catch(() => {
      // phaseVisits API 只对独立 Run 存储可读；失败时回落到快照内嵌批次（同一权威投影）。
      if (active) setVisitsFailed(true);
    });
    return () => {
      active = false;
    };
  }, [runId, attemptId, embeddedVisits]);

  const visitIsCurrent = (visit: PhaseVisit) =>
    visit.batches.some((batch) =>
      batch.agents.some((agent) => ACTIVE_STATUSES.has(agent.status)),
    );

  const visits = embeddedVisits ?? fetchedVisits;

  if (!embeddedVisits && visits === null && !visitsFailed) {
    return <div className="wf-team-panel">正在读取 Phase 轨迹…</div>;
  }

  if (!embeddedVisits && visitsFailed) {
    // 快照回落：每个 Phase 只展示快照内嵌的当前批次，无回访编号；无内嵌批次时仅列标题。
    if (!fallbackPhases) {
      return (
        <div className="wf-team-panel">
          {phaseTitles.map((title) => (
            <section className="wf-visit" key={title}>
              <header>
                <strong>{title}</strong>
                <em>轨迹不可用</em>
              </header>
            </section>
          ))}
        </div>
      );
    }
    return (
      <AnswerAllowed.Provider value={!readOnly}><div className="wf-team-panel">
        {fallbackPhases.map((phase) => {
          const active = phase.batches.some((batch) =>
            batch.agents.some((agent) => ACTIVE_STATUSES.has(agent.status)),
          );
          const status: VisitStatus = active
            ? "进行中"
            : phase.agents.length > 0
              ? "已完成"
              : "未开始";
          return (
            <section className={`wf-visit ${status === "进行中" ? "current" : ""}`} key={phase.title}>
              <header>
                <strong>{phase.title}</strong>
                {/* 与主路径一致：有节点时节点行自带状态，阶段头不再重复“已完成”。 */}
                {status === "进行中" || phase.agents.length === 0 ? <em>{status}</em> : null}
              </header>
              <VisitBatches
                visit={null}
                batches={phase.batches}
                runId={runId}
                busy={busy}
                onAnswer={onAnswer}
              />
            </section>
          );
        })}
      </div></AnswerAllowed.Provider>
    );
  }

  const sorted = [...(visits ?? [])].sort((a, b) => a.phaseVisitId - b.phaseVisitId);
  const visitedTitles = new Set(sorted.map((visit) => visit.title));
  const unvisited = phaseTitles.filter((title) => !visitedTitles.has(title));
  const reusedGroups = allVisits ? computeReusedAgents(allVisits, attemptId) : null;
  // 同标题多次访问时，复用组只挂在该标题最后一次访问下，避免重复渲染。
  const lastVisitIdByTitle = new Map<string, number>();
  for (const visit of sorted) lastVisitIdByTitle.set(visit.title, visit.phaseVisitId);
  const renderReused = (title: string, visitId: number | null) => {
    if (visitId !== null && lastVisitIdByTitle.get(title) !== visitId) return null;
    const group = reusedGroups?.get(title);
    if (!group) return null;
    return <ReusedBlock group={group} runId={runId} busy={busy} onAnswer={onAnswer} />;
  };
  return (
    <AnswerAllowed.Provider value={!readOnly}><div className="wf-team-panel">
      {sorted.map((visit) => {
        const waiting = visit.phaseVisitId === waitingVisitId;
        const current = visitIsCurrent(visit) || waiting;
        return (
          <section className={`wf-visit ${current ? "current" : ""}`} key={visit.phaseVisitId}>
            <header>
              <strong>
                {visit.title}
                {visit.occurrence > 1 && <span className="wf-revisit">第 {visit.occurrence} 轮</span>}
              </strong>
              {/* 节点行已各自带状态；阶段级状态只在“等待你/进行中/没有节点”时补充，不与节点重复。 */}
              {(() => {
                const hasAgents = visit.batches.some((batch) => batch.agents.length > 0);
                const label = waiting ? "等待你的回答" : current ? "进行中" : hasAgents ? null : "已完成";
                return label ? <em>{label}</em> : null;
              })()}
            </header>
            <VisitBatches
              visit={visit}
              batches={visit.batches}
              runId={runId}
              busy={busy}
              onAnswer={onAnswer}
            />
            {renderReused(visit.title, visit.phaseVisitId)}
          </section>
        );
      })}
      {unvisited.map((title) => (
        <section className="wf-visit" key={title}>
          <header>
            <strong>{title}</strong>
            <em>未开始</em>
          </header>
          {renderReused(title, null)}
        </section>
      ))}
      {sorted.length === 0 && unvisited.length === 0 && <p>暂无 Phase 轨迹。</p>}
    </div></AnswerAllowed.Provider>
  );
}
