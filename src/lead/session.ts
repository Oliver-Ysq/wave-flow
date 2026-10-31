import type { LeadStreamEvent } from "./types";

/** 随单条用户消息发送的附件字节；只在 Adapter 能力验证后构造。 */
export type LeadPromptAttachment = {
  /** 经 magic bytes 复核的 MIME。 */
  readonly mimeType: string;
  /** Base64 编码的附件字节。 */
  readonly dataBase64: string;
};

/** LeadService 依赖的通用主控会话；具体 CLI/Adapter 不泄漏到服务层。 */
export type LeadSession = {
  /** 订阅当前回合的瞬时 reasoning / assistant delta。 */
  subscribe(listener: (event: LeadStreamEvent) => void): () => void;
  /** 发送一轮消息；仅正常结束且正文非空才返回完整文本，限额/拒绝/取消/未知结束须reject，不代表业务验收。 */
  prompt(text: string, attachments?: readonly LeadPromptAttachment[]): Promise<string>;
  /** 提前完成 initialize/session 建立，使真实协商能力可查询；仅供附件发送前 fail closed。 */
  prepare?(): Promise<void>;
  /** initialize 协商后的图片 prompt 能力；尚未协商时为 undefined，绝不把未知冒充支持。 */
  readonly promptImageCapable?: boolean;
  /** 当前 ACP 会话广告的命令/技能；仅界面菜单使用，不进入 Journal；未提供表示不支持。 */
  readonly availableCommands?: readonly import("./types").LeadAvailableCommand[];
  /** 取消当前回合；不能将取消伪装成完整回答。 */
  abort(): void;
  /** 当前是否有尚未收敛的主控回合。 */
  readonly isRunning: boolean;
  /** 关闭 ACP/MCP 等会话资源；不会修改 Lead Journal。 */
  close?(): void;
};
