import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** 聊天输入按实际折行高度增长；窗口有限时保留历史阅读空间，超长内容才内部滚动。 */
export function AutoGrowTextarea({ onLayout, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** 输入区测量完成后通知历史区维护者；缺省不控制历史滚动，只调整输入高度。 */
  onLayout?: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const resize = useRef<() => void>(() => {});
  const layout = useRef(onLayout);
  layout.current = onLayout;

  useLayoutEffect(() => {
    const input = textarea.current;
    const conversation = input?.closest<HTMLElement>(".conversation");
    const composer = input?.closest<HTMLElement>(".conversation-composer");
    if (!input || !conversation || !composer) return;
    const region = composer.closest<HTMLElement>(".draft-input-region") ?? composer;
    const history = conversation.querySelector<HTMLElement>(".conversation-scroll");
    let frame = 0;
    const measure = () => {
      if (!input.getClientRects().length || !conversation.clientHeight) return;
      const style = getComputedStyle(input);
      const minimum = parseFloat(style.minHeight) || 68;
      const margin = getComputedStyle(region);
      const chrome = region.getBoundingClientRect().height - input.getBoundingClientRect().height
        + (parseFloat(margin.marginTop) || 0) + (parseFloat(margin.marginBottom) || 0);
      const fixed = [...conversation.children].filter(child => child !== region && child !== history)
        .reduce((height, child) => height + (getComputedStyle(child).position === "absolute" ? 0 : child.getBoundingClientRect().height), 0);
      const reserve = Math.min(160, conversation.clientHeight * .25);
      const maximum = Math.max(minimum, conversation.clientHeight - fixed - chrome - reserve);
      // 先释放旧高度才能测出删除后的真实高度；scrollHeight 同时包含自动折行和显式换行。
      input.style.height = "0px";
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const desired = Math.max(minimum, input.scrollHeight + border);
      input.style.height = `${Math.min(desired, maximum)}px`;
      input.style.overflowY = desired > maximum ? "auto" : "hidden";
      conversation.style.setProperty("--wf-composer-offset", `${region.getBoundingClientRect().height + (parseFloat(margin.marginBottom) || 0) + 12}px`);
      layout.current?.();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    resize.current = measure;
    const observer = new ResizeObserver(schedule);
    observer.observe(conversation);
    observer.observe(region);
    // 状态/任务活动栏高度变化同样会改变输入区预算，不能只监听窗口宽高。
    [...conversation.children].filter(child => child !== history && child !== region).forEach(child => observer.observe(child));
    document.fonts?.addEventListener("loadingdone", schedule);
    measure();
    return () => {
      resize.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
      conversation.style.removeProperty("--wf-composer-offset");
    };
  }, []);
  useLayoutEffect(() => { resize.current(); }, [props.value]);
  return <textarea {...props} ref={textarea} />;
}
