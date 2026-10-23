import type { AcpLauncher } from "../adapters/acp-session";

/**
 * 技能库中一个已通过静态校验的 skill。
 *
 * 只保存定位与 SKILL.md 的摘要；资源文件不参与哈希，避免每次会话扫描整棵目录。
 */
export type SkillLibraryEntry = {
  /** 目录名与 frontmatter name 一致的 kebab-case 稳定身份。 */
  readonly name: string;
  /** 该 skill 目录的 canonical 绝对路径；投影只允许软链到这里。 */
  readonly path: string;
  /** frontmatter description；用于设置页列表与导入发现展示。 */
  readonly description: string;
  /** SKILL.md 字节的 SHA-256（小写 hex），用于库摘要与证据。 */
  readonly skillMdSha256: string;
  /** SKILL.md 的字节数，用于展示与上限复核。 */
  readonly bytes: number;
  /**
   * frontmatter `metadata.requires.bins` 声明的可执行文件名；缺失/空数组表示未声明。
   * 只用于只读诊断，不由 Wave Flow 安装或加入 PATH。
   */
  readonly requiredBins: readonly string[];
};

/** 单个非法 skill 的可展示诊断；不会阻断其他合法 skill 的注入。 */
export type SkillLibraryInvalidEntry = {
  /** 目录名或候选名；可能不是合法 kebab-case。 */
  readonly name: string;
  /** 具体校验失败原因。 */
  readonly issue: string;
};

/**
 * 一次扫描得到的托管技能库状态。
 *
 * 库不存在或为空是合法空状态，不产生投影、不改变任何 CLI 启动参数。
 * 单个非法 skill 只进入 invalid，不影响其他合法 skill。
 */
export type SkillLibrary = {
  /** 库根目录的绝对路径（默认 `~/.wave-flow/skills`）。 */
  readonly root: string;
  /** 扫描时库根是否存在；缺省目录不是错误。 */
  readonly exists: boolean;
  /** 所有合法 skill 的摘要；按 name 升序，保证摘要稳定。 */
  readonly digest: string | null;
  /** 合法 skill 列表；空数组表示零注入。 */
  readonly skills: readonly SkillLibraryEntry[];
  /** 被跳过的非法 skill；无非法项时省略。 */
  readonly invalid?: readonly SkillLibraryInvalidEntry[];
};

/**
 * 每个会话在私有 scratch 下生成的投影目录。
 *
 * 投影只含软链与最小插件描述文件；不得写入技能库或任何原生 CLI 目录。
 */
export type SkillProjection = {
  /** 投影根目录，例如 `<scratch>/skills`。 */
  readonly root: string;
  /** Codex 额外根要求的具体目录：`<root>/.agents/skills`。 */
  readonly agentsSkillsDir: string;
  /** Claude `--plugin-dir` 使用的本地插件根目录。 */
  readonly claudePluginDir: string;
  /** DSH `--patch` 覆盖层文件。 */
  readonly patchFile: string;
};

/**
 * ACP session/new 的附加参数；只由已验证的注入能力产生。
 *
 * 字段为 ACP 协议标准/适配器约定，不是 Workflow 作者输入。
 */
export type SkillSessionParams = {
  /** 扩展会话文件系统范围的绝对目录；Codex 用它追加 skill 额外根。 */
  readonly additionalDirectories?: readonly string[];
  /** ACP `_meta` 透传对象；Claude 用它传本地插件列表。 */
  readonly meta?: Readonly<Record<string, unknown>>;
};

/**
 * 单个 CLI 的执行期技能注入能力。
 *
 * 能力未真实 smoke 验证前必须为 false；核心只按本声明分发，不按 CLI 名分支。
 */
export type SkillInjectionCapability = {
  /** 是否已通过真实会话验证；false 时库非空必须 fail closed。 */
  readonly verified: boolean;
  /** 证据等级：能从会话广告核对为 available-commands，否则只能证明文件已投影。 */
  readonly evidence: "available-commands" | "filesystem";
  /** 写入证据/Replay 的稳定机制名。 */
  readonly mechanism: "codex-extra-roots" | "claude-plugin-dir" | "dsh-patch";
  /** 把投影应用到 launcher 与会话参数；不得读取用户文件或启动进程。 */
  readonly apply: (input: { readonly launcher: AcpLauncher; readonly projection: SkillProjection }) => {
    /** 注入后的启动配置；未注入的字段必须原样保留。 */
    readonly launcher: AcpLauncher;
    /** 附加 ACP session/new 参数；省略表示该 CLI 不需要。 */
    readonly session?: SkillSessionParams;
  };
  /** 判断 CLI 广告的命令/技能名是否对应该 skill；用于弱证据核对。 */
  readonly advertisedMatch: (skillName: string, advertisedName: string) => boolean;
};

/**
 * 一次会话实际注入的技能证据。
 *
 * 写入 Journal provenance；参与 Replay 判定，证明“环境变化会失效”而非业务正确。
 */
export type SkillEvidence = {
  /** 会话启动时观测到的库摘要；空库为 null。 */
  readonly digest: string | null;
  /** 注入机制名。 */
  readonly mechanism: SkillInjectionCapability["mechanism"];
  /** 注入的 skill 数量。 */
  readonly count: number;
  /** 注入的 skill 名单；有上限，超出截断并保持可解释。 */
  readonly names: readonly string[];
};

/** 会话启动前完成的技能准备结果。 */
export type PreparedSessionSkills = {
  /** 可能追加了 launcher 参数的启动配置。 */
  readonly launcher: AcpLauncher;
  /** 需要在 ACP session/new 发送的附加参数。 */
  readonly session?: SkillSessionParams;
  /** 本次注入证据；空库为 null。 */
  readonly evidence: SkillEvidence | null;
};
