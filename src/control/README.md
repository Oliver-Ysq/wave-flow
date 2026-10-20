# Control

受管会话唯一的业务状态入口：`complete`、`block`、`continue`，以及只传递信息的
`answer`。自然语言、终端空闲或 ACP turn 结束都不能替代受控上报。

- 每次上报必须携带 `runId + nodeId + agentSessionId` 与当前 Engine 颁发的
  capability；Control 会再核对 Journal、ACP session 绑定与节点状态，不把稳定 ID 当
  授权依据。
- `complete` 只在结果、Schema 校验记录与 Journal 都耐久落盘后生效。
- `block` 让原工具调用等待；`answer` 只唤醒原命令，不改变节点状态；只有原 Agent 的
  `continue` 才能让 `blocked → running`。
- 用户停止收敛为 `cancelled`，未知进程/会话异常收敛为 `interrupted`；不存在 Agent
  主动上报的业务失败状态。
- `block-broker.ts` 管理等待者与答案交付，`control-server.ts` 负责身份、Schema 与
  耐久校验。
