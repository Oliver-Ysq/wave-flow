/** 工作流返回值优先呈现：人读的字符串数组按行展开，其余保留原始结构。 */
export function ResultValue({
  summary,
}: {
  /** Execution 终态保存的工作流返回值；null 表示该次执行没有返回值。 */
  summary: Record<string, unknown> | null;
}) {
  if (summary === null) return <p>这份记录未保存工作流返回结果。</p>;
  const lines = Array.isArray(summary.lines)
    ? summary.lines.filter((line): line is string => typeof line === "string")
    : [];
  if (lines.length > 0)
    return (
      <ol className="workflow-result-lines">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
    );
  return <pre>{JSON.stringify(summary, null, 2)}</pre>;
}
