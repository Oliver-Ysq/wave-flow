/** 只映射已知产品提示；未知诊断及固定前缀后的路径/外部错误保持原样。 */
export function userFacingText(text: string): string {
  const messages:Record<string,string>={
    "主控必须空闲且任务未归档，才能配置或启动工作流。":"请等待 Wave Flow 处理结束；已归档任务不能配置或运行工作流。",
    "主控必须空闲、任务未归档且无未终结执行，才能保存模板。":"请等待 Wave Flow 和当前执行结束；已归档任务不能保存工作流。",
    "只能在主控空闲时放弃当前未执行候选。":"请等待 Wave Flow 处理结束，再放弃当前方案。",
    "主控空闲且任务未归档时才能恢复原执行。":"请等待 Wave Flow 处理结束；已归档任务不能恢复执行。",
    "有主控回合进行中，主控空闲后才能切换。 ":"Wave Flow 正在处理，请结束后再切换 CLI。",
    "请先重试启动主控，不能跳过尚未开始的初始目标。":"请先重试连接，原任务目标尚未开始处理。",
    "主控已有运行回合。":"Wave Flow 正在处理。",
    "Desktop Engine 重启后无法跨进程验证原主控会话；回合已中断。 ":"执行环境重启后无法恢复原对话连接；本轮已中断。",
  };
  if(Object.hasOwn(messages,text))return messages[text]!;
  for(const [prefix,label] of [
    ["任务已创建，主控启动失败：","任务已创建，Wave Flow 连接失败："],
    ["任务及参数已保存，主控启动失败：","任务及参数已保存，Wave Flow 连接失败："],
  ])if(text.startsWith(prefix!))return label+text.slice(prefix!.length);
  return text;
}
