import skillGuide from "../../skills/workflow-creator/SKILL.md" with { type: "text" };
import apiReference from "../../skills/workflow-creator/references/api.md" with { type: "text" };
import patternReference from "../../skills/workflow-creator/references/patterns.md" with { type: "text" };
// 受限模板刻意保持非模块形状（无 import/export），因此以 .txt 存放并走 Bun text import；
// 不参与 tsc 程序，由 harness-prompt 与 skill-assets 测试保证内容与契约一致。
import restrictedTemplate from "../../skills/workflow-creator/assets/workflow.restricted.txt" with { type: "text" };

/**
 * 主控的固定行为边界；工具能力由 session-private MCP sidecar 提供。
 * 该文本只约束主控能做什么，不教 workflow 写法；作者契约来自下方注入的 skill。
 */
const HARNESS_SYSTEM_PROMPT = "你是 Wave Flow 主控。你必须基于 session 中提供的 wave-flow-harness MCP 工具处理项目事实、提出 workflow 草案、读取执行结果或请求用户决定。你只能使用该 MCP 的只读查询和四个窄工具；禁止写入业务工作区、直接创建 Worker、直接执行 Workflow、调用 wave-flow complete/block/continue，或仅凭自然语言声称任务已完成。propose_workflow_revision 只产生草案，用户接受后才可能创建 Execution。";

/**
 * 组合主控系统 prompt：行为边界在前，workflow-creator skill 全文在后。
 *
 * skill 以 text import 内嵌，经 `bun build --compile` 后进入 Engine 二进制；主控 ACP
 * 会话的 cwd 是用户项目而非本仓库，无法运行时回读 skill 文件，因此这是主控获得作者
 * 契约的唯一通道。skill 正文中指向 references/ 的链接在此拍平为顺序拼接的两个附录。
 * 修改 `skills/workflow-creator/` 后必须重新构建 Engine 才对主控生效。
 */
export function buildHarnessSystemPrompt(): string {
  return [
    HARNESS_SYSTEM_PROMPT,
    "# Workflow 作者契约\n\n以下是 Wave Flow workflow-creator skill 全文，是 workflow 草案的唯一契约依据。正文中引用的 references/api.md、references/patterns.md 与受限草案完整模板已作为附录完整附在最后，无需也无法再读取磁盘文件。",
    skillGuide,
    "# 附录：references/api.md",
    apiReference,
    "# 附录：references/patterns.md",
    patternReference,
    "# 附录：assets/workflow.restricted.txt（受限草案完整模板，持续通过真实校验门禁）",
    restrictedTemplate,
  ].join("\n\n");
}
