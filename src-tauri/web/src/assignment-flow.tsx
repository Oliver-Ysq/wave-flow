import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  ExecutionConfigSnapshot,
  ExecutionPlanResponse,
  ExecutionResponse,
  WorkerAssignment,
} from "./types";

/**
 * 冻结 revision 后的分配卡流程：卡片一 CLI 分配（主控 CLI / 随机 / 自然语言规则），
 * 卡片二模型分配（本期只读“跟随 CLI 默认”），确认页逐 Worker 展示来源与回退路径。
 * 两张卡横向滑动切换；只有用户确认后才携带 config 创建 Execution。
 */
export function ExecutionAssignmentFlow({
  harnessRunId,
  revision,
  onCancel,
  onCreated,
}: {
  harnessRunId: string;
  revision: number;
  onCancel: () => void;
  onCreated: (detail: ExecutionResponse) => void;
}) {
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(null);
  const [assignments, setAssignments] = useState<WorkerAssignment[]>([]);
  const [defaultAssignment, setDefaultAssignment] =
    useState<WorkerAssignment | null>(null);
  const [mode, setMode] = useState<"harness-cli" | "random" | "rule">(
    "harness-cli",
  );
  const [ruleText, setRuleText] = useState("");
  const [appliedRule, setAppliedRule] = useState<string | null>(null);
  const [ruleDegraded, setRuleDegraded] = useState(false);
  const [ruleDiagnostic, setRuleDiagnostic] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .planExecution(harnessRunId, revision)
      .then((value) => {
        if (!active) return;
        setPlan(value);
        // 首次进入生成一次分配：默认全部用主控 CLI；之后只在用户切换或重新随机时变化。
        if (value.harnessRuntime) applyHarnessCli(value);
        else setError("尚未设置已验证的主控 CLI；请先在“执行底座”中设置，再创建 Execution。");
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessRunId, revision]);

  function assignmentFor(
    agentId: string,
    runtime: NonNullable<ExecutionPlanResponse["harnessRuntime"]>,
    source: WorkerAssignment["source"],
  ): WorkerAssignment {
    return {
      agentId,
      cli: runtime.cli,
      model: "cli-default",
      source,
      runtimeId: runtime.runtimeId,
      adapterId: runtime.verifiedAdapter.adapterId,
      adapterVersion: runtime.verifiedAdapter.adapterVersion,
    };
  }

  function applyHarnessCli(value: ExecutionPlanResponse) {
    const harness = value.harnessRuntime!;
    setAssignments(
      value.workers.map((worker) =>
        assignmentFor(worker.id, harness, "harness-cli"),
      ),
    );
    setDefaultAssignment(assignmentFor("*", harness, "harness-cli"));
    setMode("harness-cli");
    setAppliedRule(null);
    setRuleDegraded(false);
    setRuleDiagnostic(null);
  }

  async function applyRandom(value: ExecutionPlanResponse) {
    setBusy("randomize");
    try {
      const result = await api.randomizeExecutionAssignment(
        harnessRunId,
        revision,
      );
      setAssignments(result.assignments);
      setDefaultAssignment(result.defaultAssignment);
      setMode("random");
      setAppliedRule(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function parseRule() {
    if (!plan || !ruleText.trim()) return;
    setBusy("parse-rule");
    setRuleDiagnostic(null);
    try {
      const result = await api.parseExecutionRule(
        harnessRunId,
        revision,
        ruleText.trim(),
      );
      setAppliedRule(ruleText.trim());
      if (result.degraded || !result.assignments) {
        // 解析失败绝不静默猜测：显式标注退化并落回随机分配。
        setRuleDegraded(true);
        setRuleDiagnostic(
          result.diagnostic ?? "主控未能给出合规的分配结果。",
        );
        await applyRandom(plan);
        setMode("rule");
        setAppliedRule(ruleText.trim());
        setRuleDegraded(true);
        setRuleDiagnostic(
          result.diagnostic ?? "主控未能给出合规的分配结果。",
        );
        return;
      }
      const overrides = new Map(
        result.assignments.map((item) => [item.agentId, item]),
      );
      setAssignments((current) =>
        current.map((item) => overrides.get(item.agentId) ?? item),
      );
      setRuleDegraded(false);
      setMode("rule");
    } catch (cause) {
      setRuleDegraded(true);
      setRuleDiagnostic(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  function scrollToCard(index: number) {
    const container = scrollRef.current;
    if (!container) return;
    const width = container.clientWidth;
    container.scrollTo({ left: width * index, behavior: "smooth" });
  }

  async function confirm() {
    if (!defaultAssignment) return;
    setBusy("create");
    try {
      const config: ExecutionConfigSnapshot = {
        version: 1,
        createdAt: new Date().toISOString(),
        fallbackRuntimeId: defaultAssignment.runtimeId,
        ruleText: appliedRule,
        ruleDegraded,
        defaultAssignment,
        assignments,
      };
      const detail = await api.createExecution(harnessRunId, revision, config);
      onCreated(detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const poolById = new Map(
    (plan?.pool ?? []).map((runtime) => [runtime.runtimeId, runtime]),
  );
  const sourceLabel = (source: WorkerAssignment["source"]) =>
    source === "harness-cli"
      ? "主控 CLI"
      : source === "random"
        ? "随机分配"
        : source === "rule"
          ? "规则解析"
          : "脚本字面量";
  const runtimeLabel = (runtimeId: string) => {
    const runtime = poolById.get(runtimeId);
    return runtime
      ? `${runtime.cli === "codex" ? "Codex" : "Kimi"} · ${runtime.version}`
      : runtimeId.slice(0, 8);
  };

  return (
    <article className="conversation-action assignment-flow">
      <div className="assignment-head">
        <span>分配 Worker 执行底座</span>
        <button
          type="button"
          className="assignment-collapse"
          onClick={onCancel}
          aria-label="收起分配卡"
        >
          ×
        </button>
      </div>
      <p className="assignment-note">
        脚本写死的 cli/model 在受限 Execution 中不直接生效；节点落点以这里冻结的分配为准。
      </p>
      {!plan ? (
        <p className="assignment-note">{error ?? "正在枚举 Worker…"}</p>
      ) : (
        <>
          {plan.dynamicCount > 0 && (
            <p className="assignment-dynamic" aria-live="polite">
              脚本含 {plan.dynamicCount} 个动态 id 的 agent()
              调用，无法静态枚举；它们运行时使用兜底分配（默认为主控 CLI）。
            </p>
          )}
          <div className="assignment-cards" ref={scrollRef}>
            <section className="assignment-card">
              <span className="assignment-kicker">卡片 1 / 3</span>
              <h3>CLI 分配</h3>
              <div className="assignment-modes" role="radiogroup" aria-label="CLI 分配方式">
                <label>
                  <input
                    type="radio"
                    name={`assignment-mode-${revision}`}
                    checked={mode === "harness-cli"}
                    onChange={() => applyHarnessCli(plan)}
                  />
                  全部用主控 CLI（{plan.harnessRuntime ? runtimeLabel(plan.harnessRuntime.runtimeId) : "未设置"}）
                </label>
                <label>
                  <input
                    type="radio"
                    name={`assignment-mode-${revision}`}
                    checked={mode === "random"}
                    disabled={busy === "randomize"}
                    onChange={() => void applyRandom(plan)}
                  />
                  随机分配（相邻 Worker 轮换池内 CLI）
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy === "randomize"}
                    onClick={(event) => {
                      event.preventDefault();
                      void applyRandom(plan);
                    }}
                  >
                    {busy === "randomize" ? "正在随机…" : "重新随机"}
                  </button>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`assignment-mode-${revision}`}
                    checked={mode === "rule"}
                    onChange={() => setMode("rule")}
                  />
                  自然语言规则（由主控普通回合解析）
                </label>
              </div>
              {mode === "rule" && (
                <div className="assignment-rule">
                  <textarea
                    value={ruleText}
                    disabled={busy === "parse-rule"}
                    onChange={(event) => setRuleText(event.target.value)}
                    placeholder="例如：甲用 codex，其余用 kimi"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!ruleText.trim() || busy === "parse-rule"}
                    onClick={() => void parseRule()}
                  >
                    {busy === "parse-rule" ? "正在解析…" : "解析规则"}
                  </button>
                  {ruleDegraded && (
                    <p className="assignment-degraded" role="alert">
                      规则解析失败，已退化为随机分配。
                      {ruleDiagnostic ? `（${ruleDiagnostic}）` : ""}
                    </p>
                  )}
                </div>
              )}
              <ul className="assignment-list">
                {assignments.map((item) => (
                  <li key={item.agentId}>
                    <strong>{item.agentId}</strong>
                    <span>{runtimeLabel(item.runtimeId)}</span>
                    <em>{sourceLabel(item.source)}</em>
                  </li>
                ))}
              </ul>
            </section>
            <section className="assignment-card">
              <span className="assignment-kicker">卡片 2 / 3</span>
              <h3>模型分配</h3>
              <p className="assignment-note">
                本期每个 Worker 都跟随 CLI 默认模型；模型覆盖尚未验证，不提供选择。
              </p>
              <ul className="assignment-list">
                {assignments.map((item) => (
                  <li key={item.agentId}>
                    <strong>{item.agentId}</strong>
                    <span>{runtimeLabel(item.runtimeId)}</span>
                    <em>跟随 CLI 默认</em>
                  </li>
                ))}
              </ul>
            </section>
            <section className="assignment-card">
              <span className="assignment-kicker">卡片 3 / 3</span>
              <h3>确认分配</h3>
              <ul className="assignment-list">
                {assignments.map((item) => (
                  <li key={item.agentId}>
                    <strong>{item.agentId}</strong>
                    <span>
                      {item.cli === "codex" ? "Codex" : "Kimi"} · 跟随 CLI
                      默认 · {sourceLabel(item.source)}
                    </span>
                    <em>{runtimeLabel(item.runtimeId)}</em>
                  </li>
                ))}
              </ul>
              <p className="assignment-note">
                兜底分配（动态 Worker）：{defaultAssignment ? runtimeLabel(defaultAssignment.runtimeId) : "—"}
                。任一 Worker 启动前失败时，回退到主控 Runtime
                （{plan.harnessRuntime ? runtimeLabel(plan.harnessRuntime.runtimeId) : "未设置"}）并重试一次；已投递节点绝不自动换
                CLI。
              </p>
              {appliedRule && (
                <p className="assignment-note">规则原文：{appliedRule}</p>
              )}
            </section>
          </div>
          <div className="assignment-nav">
            <button type="button" className="button-secondary" onClick={() => scrollToCard(0)}>
              CLI
            </button>
            <button type="button" className="button-secondary" onClick={() => scrollToCard(1)}>
              模型
            </button>
            <button type="button" className="button-secondary" onClick={() => scrollToCard(2)}>
              确认
            </button>
          </div>
          {error && <p className="assignment-error">{error}</p>}
          <div className="assignment-actions">
            <button type="button" className="button-secondary" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              disabled={!defaultAssignment || busy === "create"}
              onClick={() => void confirm()}
            >
              {busy === "create" ? "正在创建执行…" : "确认并创建 Execution"}
            </button>
          </div>
        </>
      )}
    </article>
  );
}
