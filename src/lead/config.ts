/**
 * 历史测试注入用的模型配置形状。
 *
 * Desktop 产品不读取、保存或展示此配置；真实 Lead 只能经用户验证的 ACP CLI
 * Runtime 建立。保留类型是为了让旧测试夹具能注入一个不连接网络的假会话。
 */
export type ResolvedLeadModelConfig = {
  /** 测试夹具标识，不是 Desktop 可配置模型。 */
  readonly model: string;
  /** 测试夹具地址；生产不消费。 */
  readonly baseUrl: string;
  /** 测试夹具字段；生产不读取。 */
  readonly apiKey: string;
};
