import { useState, type ReactNode } from "react";
import { ViewCache } from "../workbench-state";
const entryExpansion=new ViewCache<boolean>(256);
import type {
  LeadThoughtEntry,
  LeadToolEntry,
  LeadToolKind,
} from "../types";
import { toolGroupLabel, toolGroupStatus, toolGroupTimes } from "./entry-groups";

/** 计算条目真实耗时文案；进行中的条目显示"进行中"，不推断剩余时间。 */
function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (finishedAt === null) return "进行中";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/** 条目状态徽标文案与修饰类；状态同时以文字和色点表达，不只依赖颜色。 */
function statusBadge(status: string): { text: string; className: string } {
  switch (status) {
    case "running":
      return { text: "运行中", className: "running" };
    case "completed":
      return { text: "已完成", className: "completed" };
    case "failed":
      return { text: "失败", className: "failed" };
    case "interrupted":
      return { text: "已中断", className: "interrupted" };
    default:
      return { text: status, className: "unknown" };
  }
}

/** 统一的内联 SVG 图标；不引入图标库，按条目种类区分图形。 */
function EntryGlyph({ kind }: { kind: LeadToolKind | "thought" }) {
  const paths: Record<string, ReactNode> = {
    thought: (
      <path d="M8 3a4.5 4.5 0 0 0-2.6 8.2c.5.4.6 1 .6 1.8h4c0-.8.1-1.4.6-1.8A4.5 4.5 0 0 0 8 3ZM6.5 14h3" />
    ),
    "file-read": (
      <path d="M4 2.5h5l3 3v8H4v-11ZM9 2.5v3h3" />
    ),
    "file-write": (
      <path d="M4 2.5h5l3 3v8H4v-11ZM9 2.5v3h3M6 10.5l1.5 1.5 3-3" />
    ),
    command: <path d="M4 4.5 7 8l-3 3.5M8.5 12h4" />,
    search: <path d="M7 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM9.5 9.5 13 13" />,
    mcp: <path d="M3.5 8h2l1.5-3 2 6L10.5 8h2" />,
    unknown: <path d="M8 3.5 13 12.5H3L8 3.5ZM8 7v2.5M8 11h.01" />,
  };
  return (
    <svg
      className="wf-entry-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {paths[kind]}
    </svg>
  );
}

/**
 * 紧凑折叠行外壳：图标 + 名称 + 目标摘要 + 耗时 + 状态徽标 + 展开按钮。
 * 展开按钮是真实 <button> 并带 aria-expanded，键盘可达。
 */
function CollapsibleEntryRow({
  glyph,
  name,
  labelText,
  summary,
  startedAt,
  finishedAt,
  status,
  defaultOpen = false,
  detail,
  identity,
}: {
  /** 左侧小图标种类。 */
  glyph: LeadToolKind | "thought";
  /** 行标题（工具名或"思考过程"），可附带徽标等内联元素。 */
  name: ReactNode;
  /** 无障碍纯文本名称；name 含 JSX 时由它提供可读标签。 */
  labelText: string;
  /** 目标摘要（路径/命令/搜索目标等），可为 null。 */
  summary: string | null;
  /** 起始时间，用于计算真实耗时。 */
  startedAt: string;
  /** 结束时间；null 表示仍在运行。 */
  finishedAt: string | null;
  /** 条目状态，用于徽标。 */
  status: string;
  /** 初始展开；用于进行中的聚合组默认展开，结束后用户可手动收起。 */
  defaultOpen?: boolean;
  /** 展开区内容；为 null 时行不可展开。 */
  detail: ReactNode;
  /** 原耐久条目/聚合首条身份；不用名称或时间猜跨任务归属。 */
  identity?: string;
}) {
  const expansionKey=identity??`${startedAt}:${labelText}`;
  const [open, setOpen] = useState(()=>entryExpansion.get(expansionKey)??defaultOpen);
  const badge = statusBadge(status);
  return (
    <div className={`wf-entry ${badge.className}`}>
      <div className="wf-entry-row">
        <EntryGlyph kind={glyph} />
        <span className="wf-entry-name">{name}</span>
        {summary && (
          <span className="wf-entry-summary" title={summary}>
            {summary}
          </span>
        )}
        <span className="wf-entry-duration">
          {formatDuration(startedAt, finishedAt)}
        </span>
        <span className={`wf-entry-badge ${badge.className}`}>
          <i aria-hidden="true" />
          {badge.text}
        </span>
        {detail !== null && (
          <button
            type="button"
            className="wf-entry-toggle"
            aria-expanded={open}
            aria-label={open ? `收起 ${labelText}` : `展开 ${labelText}`}
            onClick={() => setOpen((current) => {entryExpansion.set(expansionKey,!current);return !current;})}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
            </svg>
          </button>
        )}
      </div>
      {open && detail !== null && <div className="wf-entry-detail">{detail}</div>}
    </div>
  );
}

/**
 * 连续工具调用的聚合摘要行："读取了 2 个文件 · 运行了 1 条命令 ›"。
 * 进行中默认展开以便逐条看到实时状态；展开后组内仍复用单条 ToolBlock。
 */
export function ToolGroupBlock({ entries }: { entries: LeadToolEntry[] }) {
  const label = toolGroupLabel(entries);
  const status = toolGroupStatus(entries);
  const { startedAt, finishedAt } = toolGroupTimes(entries);
  return (
    <CollapsibleEntryRow
      identity={entries[0]?.entryId}
      glyph={entries[0]?.toolKind ?? "unknown"}
      name={label}
      labelText={label}
      summary={null}
      startedAt={startedAt}
      finishedAt={finishedAt}
      status={status}
      defaultOpen={status === "running"}
      detail={
        <div className="wf-entry-group-items">
          {entries.map((entry) => (
            <ToolBlock key={entry.entryId} entry={entry} />
          ))}
        </div>
      }
    />
  );
}

/** 思考条目块：折叠行显示耗时与状态；展开显示思考正文纯文本。 */
export function ThoughtBlock({ entry }: { entry: LeadThoughtEntry }) {
  if (entry.legacy) {
    return (
      <CollapsibleEntryRow
        identity={entry.entryId}
        glyph="thought"
        name="思考过程"
        labelText="思考过程"
        summary={null}
        startedAt={entry.startedAt}
        finishedAt={entry.finishedAt}
        status={entry.status}
        detail={null}
      />
    );
  }
  return (
    <CollapsibleEntryRow
      identity={entry.entryId}
      glyph="thought"
      name="思考过程"
      labelText="思考过程"
      summary={null}
      startedAt={entry.startedAt}
      finishedAt={entry.finishedAt}
      status={entry.status}
      detail={
        <>
          <pre className="wf-thought-text">{entry.text}</pre>
          {entry.status === "interrupted" && (
            <p className="wf-entry-note">已中断</p>
          )}
          {entry.truncated && <p className="wf-entry-note">记录已截断</p>}
        </>
      }
    />
  );
}

/** command 类工具的复制按钮：就地反馈成功或失败。 */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      className="wf-copy-button"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setState("ok"))
          .catch(() => setState("fail"));
      }}
    >
      {state === "ok" ? "已复制" : state === "fail" ? "复制失败" : "复制"}
    </button>
  );
}

/** 按 toolKind 分类的工具条目详情；engine-mcp 来源的任何 kind 都带 MCP 徽标。 */
export function ToolBlock({ entry }: { entry: LeadToolEntry }) {
  const isMcp = entry.source === "engine-mcp";
  const name = (
    <>
      {isMcp && <span className="wf-mcp-badge">MCP</span>}
      {entry.name}
    </>
  );
  if (entry.legacy || !entry.hasDetail) {
    return (
      <CollapsibleEntryRow
        identity={entry.entryId}
        glyph={entry.toolKind}
        name={name}
        labelText={entry.name}
        summary={null}
        startedAt={entry.startedAt}
        finishedAt={entry.finishedAt}
        status={entry.status}
        detail={<p className="wf-entry-note">历史记录未保存</p>}
      />
    );
  }
  const truncatedNote = entry.outputTruncated && (
    <p className="wf-entry-note">记录已截断</p>
  );
  const output = entry.output;
  let detail: ReactNode;
  switch (entry.toolKind) {
    case "file-read":
      detail = (
        <>
          {output !== null && <pre className="wf-tool-output">{output}</pre>}
          {truncatedNote}
        </>
      );
      break;
    case "file-write":
      detail = (
        <>
          {output !== null && <pre className="wf-tool-output">{output}</pre>}
          {truncatedNote}
        </>
      );
      break;
    case "command":
      detail = (
        <>
          {entry.target && (
            <div className="wf-command-line">
              <code>{entry.target}</code>
              <CopyButton text={entry.target} />
            </div>
          )}
          {entry.exitCode !== null && (
            <p className="wf-entry-note">退出码 {entry.exitCode}</p>
          )}
          {output !== null && (
            <pre className="wf-tool-output wf-terminal">{output}</pre>
          )}
          {truncatedNote}
        </>
      );
      break;
    case "search":
      detail = (
        <>
          {output !== null && <pre className="wf-tool-output">{output}</pre>}
          {truncatedNote}
        </>
      );
      break;
    case "mcp":
      detail = (
        <>
          {entry.paramsSummary && (
            <p className="wf-entry-params">{entry.paramsSummary}</p>
          )}
          {output !== null && <pre className="wf-tool-output">{output}</pre>}
          {truncatedNote}
        </>
      );
      break;
    default:
      detail = (
        <>
          {entry.paramsSummary && (
            <p className="wf-entry-params">{entry.paramsSummary}</p>
          )}
          {output !== null && <pre className="wf-tool-output">{output}</pre>}
          {truncatedNote}
        </>
      );
  }
  return (
    <CollapsibleEntryRow
      glyph={entry.toolKind}
      name={name}
      labelText={entry.name}
      summary={entry.target}
      identity={entry.entryId}
      startedAt={entry.startedAt}
      finishedAt={entry.finishedAt}
      status={entry.status}
      detail={detail}
    />
  );
}
