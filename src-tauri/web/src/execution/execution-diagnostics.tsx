import { useState } from "react";

/** 诊断信息复制按钮；仅在用户展开高级信息后按需复制证据。 */
export function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy-value"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.setTimeout(() => setDone(false), 1_500);
        } catch { /* 剪贴板不可用时保持可选择复制。 */ }
      }}
    >
      {done ? "已复制" : "复制"}
    </button>
  );
}

/**
 * 执行页的 L3 工程标识：executionId/sourceHash/Runtime 版本/attempt/回退 Runtime
 * 一律收进折叠的诊断区，默认界面只保留 revision 与分配叙事。
 */
export function ExecutionDiagnostics({
  executionId,
  sourceHash,
  runtimeVersion,
  currentAttempt,
  fallbackRuntimeId,
}: {
  /** Execution UUID；复制证据用。 */
  executionId: string;
  /** 冻结源码 SHA-256 完整值。 */
  sourceHash: string;
  /** 创建 Execution 时的 Runtime 版本。 */
  runtimeVersion: number;
  /** 当前执行尝试号；历史叙述在别处按 attempt 选择器呈现。 */
  currentAttempt: number;
  /** 启动前失败的回退 Runtime id；无分配配置时为 null。 */
  fallbackRuntimeId: string | null;
}) {
  return (
    <details className="execution-diagnostics">
      <summary>高级 / 诊断信息</summary>
      <dl>
        <dt>executionId</dt>
        <dd><code>{executionId}</code><CopyValue value={executionId} /></dd>
        <dt>sourceHash</dt>
        <dd><code>{sourceHash}</code><CopyValue value={sourceHash} /></dd>
        <dt>Runtime 版本</dt>
        <dd>v{runtimeVersion}</dd>
        <dt>当前 attempt</dt>
        <dd>#{currentAttempt}</dd>
        {fallbackRuntimeId && (
          <>
            <dt>回退 Runtime</dt>
            <dd><code>{fallbackRuntimeId}</code><CopyValue value={fallbackRuntimeId} /></dd>
          </>
        )}
      </dl>
    </details>
  );
}
