/** 当前支持的用户本机 Coding CLI；新 CLI 只在其 ACP Adapter、测试与能力验证完成后加入。 */
export type RuntimeCli = "codex" | "kimi" | "claude" | "dsh";

/** 发现候选时的来源；仅用于用户展示与审计，不保存 PATH 或 shell 环境。 */
export type RuntimeDiscoverySource = "shell-path" | "gui-path" | "install-dir" | "manual";

/** 已保存 runtime 的可用性；只有 verified 可以被 Worker 使用。 */
export type CliRuntimeStatus = "verified" | "needs-revalidation" | "invalid";

/** 可执行文件的稳定身份快照；不向 Web 直接回显 inode/device。 */
export type ExecutableIdentity = {
  /** 文件系统设备号，用于检测被替换的二进制。 */
  readonly device: number;
  /** 文件系统 inode，用于检测被替换的二进制。 */
  readonly inode: number;
  /** 验证时的文件字节数。 */
  readonly size: number;
  /** 验证时的最后修改时间戳（毫秒）。 */
  readonly modifiedAtMs: number;
};

/** 内置 ACP adapter 的验证来源。 */
export type VerifiedAdapter = {
  /** 固定 adapter 标识；只允许 Adapter Catalog 中已声明的内置 adapter。 */
  readonly adapterId: "codex-acp" | "kimi-acp" | "claude-acp" | "dsh-acp";
  /** lockfile 中 adapter 版本。 */
  readonly adapterVersion: string;
  /** 握手确认的 ACP 协议版本。 */
  readonly acpProtocolVersion: number;
  /** 该 adapter 是否已验证支持为主控注入 session-scoped MCP 窄工具。 */
  readonly leadTools: boolean;
};

/** 用户明确确认后写入私有 Registry 的 CLI runtime。 */
export type CliRuntimeRecord = {
  /** 稳定 UUID。 */
  readonly runtimeId: string;
  /** 该 executable 的 CLI 种类。 */
  readonly cli: RuntimeCli;
  /** 经过 realpath 的绝对常规文件路径。 */
  readonly executablePath: string;
  /** 写入时冻结的文件身份。 */
  readonly executableIdentity: ExecutableIdentity;
  /** JavaScript 入口 CLI 使用的 node；仅 requiresNodeRuntime 的 adapter 必须存在；旧记录可缺失，首次启动时受控补解析。 */
  readonly nodeExecutable?: { readonly path: string; readonly identity: ExecutableIdentity };
  /** 固定 argv `--version` 返回的规范化版本摘要。 */
  readonly version: string;
  /** 候选进入验证流程的来源。 */
  readonly discoveredFrom: RuntimeDiscoverySource;
  /** 发现使用的 shell 路径；手动或 GUI PATH 时为 null。 */
  readonly discoveredShell: string | null;
  /** 已实际完成 initialize/session/new 的 adapter 信息。 */
  readonly verifiedAdapter: VerifiedAdapter;
  /** 最近一次完整验证完成时间。 */
  readonly verifiedAt: string;
  /** 新 Worker 的允许状态。 */
  readonly status: CliRuntimeStatus;
  /** 非 verified 状态的可展示诊断；不得包含 shell 环境或认证信息。 */
  readonly diagnostic: string | null;
};

/** Registry 私有文件格式。 */
export type CliRuntimeRegistryFile = {
  /** 当前文件格式版本。 */
  readonly version: 1;
  /** 每个 CLI 当前用户明确选择的 runtime id；作为各 CLI 的 Worker 偏好，主控解析不读它。 */
  readonly selectedByCli: Partial<Record<RuntimeCli, string>>;
  /**
   * 新建主控会话使用的 runtime id；与 Worker 池正交。
   * 旧文件缺省时读取回填为 `selectedByCli["codex"]`（语义不变的用户原默认）；必须引用存在的记录。
   */
  readonly leadRuntimeId?: string;
  /** 所有经验证或待重验的 runtime 记录。 */
  readonly runtimes: readonly CliRuntimeRecord[];
};

/** 通过启动前身份复核、可安全注入 Worker 的运行时。 */
export type VerifiedCliRuntime = Omit<CliRuntimeRecord, "nodeExecutable" | "status"> & {
  readonly status: "verified";
  /** 仅 requiresNodeRuntime 的 adapter（codex-acp、dsh-acp）保证存在；claude 原生二进制与 kimi 等自包含 CLI 不写该字段。 */
  readonly nodeExecutable?: { readonly path: string; readonly identity: ExecutableIdentity };
};

/** 写入 Journal 的安全 runtime 来源；不含 device/inode、PATH 或环境变量。 */
export type RuntimeProvenance = {
  /** Registry runtime id。 */
  readonly runtimeId: string;
  /** CLI 稳定类型。 */
  readonly cli: RuntimeCli;
  /** 用户确认的 realpath。 */
  readonly executablePath: string;
  /** 经验证的版本摘要。 */
  readonly version: string;
  /** adapter id。 */
  readonly adapterId: "codex-acp" | "kimi-acp" | "claude-acp" | "dsh-acp";
  /** adapter 锁定版本。 */
  readonly adapterVersion: string;
  /** 最后完整验证时间。 */
  readonly verifiedAt: string;
  /**
   * 本会话执行期注入的技能证据；未注入时省略。
   *
   * 参与 Replay 判定：库摘要变化时旧 completed 结果不得复用。它只证明环境已变化，
   * 不证明模型实际使用了某个 skill。
   */
  readonly skills?: import("../skills/types").SkillEvidence;
};

/** 仅在设置页展示的 runtime 字段；文件身份绝不返回浏览器。 */
export type CliRuntimeView = Omit<CliRuntimeRecord, "executableIdentity" | "nodeExecutable">;

/** 发现到的未确认候选。 */
export type DiscoveredCliCandidate = {
  /** 按可执行文件名判定的 CLI 种类；realpath 后保持不变。 */
  readonly cli: RuntimeCli;
  /** canonical realpath；重复 PATH 入口已经合并。 */
  readonly executablePath: string;
  /** 候选来源；`install-dir` 只在 login shell 与 GUI PATH 都没有该 CLI 时兜底。 */
  readonly discoveredFrom: Exclude<RuntimeDiscoverySource, "manual">;
  /** 发现 shell；GUI PATH 时为 null。 */
  readonly discoveredShell: string | null;
  /** 相同 realpath 的其他显示路径。 */
  readonly aliases: readonly string[];
};
