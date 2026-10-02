/** 可探测环境能力的三态结论；unknown 不能被当作可用。 */
export type CapabilityStatus = "available" | "unavailable" | "unknown";

/** 单个 CLI Adapter 的最小可证明能力。 */
export type AdapterCapabilities = {
  /** Adapter 二进制及最小集成是否可用；仅二进制存在不代表交互会话已验证。 */
  readonly status: CapabilityStatus;
  /** 正常交互式会话是否已被当前 Adapter 实现并验证。 */
  readonly interactiveSession: CapabilityStatus;
  /** composer 就绪、首条 Prompt 提交及进入会话是否已被验证。 */
  readonly verifiedPromptDelivery: CapabilityStatus;
  /** 与 tmux 持久会话组合是否已被实现并验证。 */
  readonly persistentTmuxSession: CapabilityStatus;
  /** Adapter 实际可证明实施的 sandbox 权限。 */
  readonly sandbox: {
    /** read-only sandbox 是否可证明生效。 */
    readonly readOnly: CapabilityStatus;
    /** workspace-write sandbox 是否可证明生效。 */
    readonly workspaceWrite: CapabilityStatus;
  };
};

/** 当前主机和 Adapter 的机器可读能力快照。 */
export type CapabilitySnapshot = {
  /** 能力快照 JSON 格式版本。 */
  readonly version: 1;
  /** 当前本机平台和 tmux 能力。 */
  readonly host: {
    /** Bun 运行时报告的平台名。 */
    readonly platform: string;
    /** tmux 命令与持久会话支持的独立能力。 */
    readonly tmux: {
      /** tmux 二进制是否可被探测到。 */
      readonly status: CapabilityStatus;
      /** Wave Flow 是否已能管理可恢复的 tmux 会话；未实现时不可报告 available。 */
      readonly persistentSessions: CapabilityStatus;
    };
  };
  /** 当前已知 Adapter 能力；4.2 仅报告 Codex。 */
  readonly adapters: { readonly codex: AdapterCapabilities };
};

/** 判断能力是否明确 available；unknown 和 unavailable 一律 fail closed。 */
export function isCapabilityAvailable(status: CapabilityStatus): boolean { return status === "available"; }

/** 在启动节点前要求指定能力全部 available；缺失项会形成稳定诊断。 */
export function requireCapabilities(requirements: Readonly<Record<string, CapabilityStatus>>): void {
  const unavailable = Object.entries(requirements).filter(([, status]) => !isCapabilityAvailable(status)).map(([name, status]) => `${name}=${status}`);
  if (unavailable.length > 0) throw new Error(`节点启动前能力不足：${unavailable.join(", ")}`);
}
