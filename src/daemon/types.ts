import type { JsonObject } from "../shared/json";
import type { RunSnapshot } from "../runtime/run-types";

/** 创建 Run 的 loopback API 请求；Workflow 路径相对于 cwd 解析。 */
export type CreateRunRequest = {
  /** 当前 CLI 为本次创建生成的 UUID；网络响应丢失后的重试必须复用它。 */
  readonly clientRequestId: string;
  /** 用户明确指定的本地 TypeScript Workflow 路径。 */
  readonly workflowPath: string;
  /** 项目 cwd；daemon 以此限制 Workflow 和状态目录边界。 */
  readonly cwd: string;
  /** 传给 Workflow default run(args) 的 JSON-safe 对象。 */
  readonly input: JsonObject;
  /** 是否使用 Botmux 风格 App Server hybrid 投递；默认 true，Workflow 源码不可设置。 */
  readonly codexRpcInput?: boolean;
};

/** 创建或查询 Run 的 loopback API 响应。 */
export type RunResponse = {
  /** Journaled Run 的稳定 id。 */
  readonly runId: string;
  /** daemon 权威的 Phase → Agent 查询快照。 */
  readonly snapshot: RunSnapshot;
};
