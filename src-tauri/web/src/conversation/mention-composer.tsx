import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Mention, MentionsInput, type DataFunc, type MentionItem, type SuggestionDataItem } from "react-mentions";
import { buildComposerSlashCommands, type ComposerSlashCommand } from "./composer-commands";

type MentionDatum = SuggestionDataItem & {
  readonly description: string;
  readonly inputHint: string | null;
};

/** 把草稿里已有的命令 token 还原为 mention markup；只处理完整 token，避免误伤普通文本。 */
function plainToMarkup(plain: string, commands: readonly ComposerSlashCommand[]): string {
  const tokens = commands
    .map((command) => command.token)
    .filter((token) => token.length > 0)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return plain;
  const pattern = new RegExp(`(^|\\s)(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=\\s|$)`, "g");
  return plain.replace(pattern, (_match, leading: string, token: string) => `${leading}@[${"\u00A0".repeat(4)}${token}\u00A0\u00A0](${token})`);
}

/**
 * react-mentions 的 textarea 显示文本使用 displayTransform 去掉前导 `/`；Engine 需要完整 token，
 * 因此用 mentions 的 id 把显示文本还原成命令文本。多个 mention 从后往前替换，避免位置漂移。
 */
export function engineTextFromMentions(plain: string, mentions: readonly MentionItem[]): string {
  let text = plain;
  for (const mention of [...mentions].sort((a, b) => b.plainTextIndex - a.plainTextIndex)) {
    const display = mention.display ?? "";
    if (!display) continue;
    // display 可能包含 mention 内部的尾随空格；换回 id 时保留它，避免命令与后续文字粘连。
    const trailing = display.match(/\s*$/u)?.[0] ?? "";
    text = `${text.slice(0, mention.plainTextIndex)}${mention.id}${trailing}${text.slice(mention.plainTextIndex + display.length)}`;
  }
  return text;
}

function isSubmit(event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean {
  return event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey;
}

/**
 * 主控输入框的 mention 版实现。
 *
 * 使用成熟 textarea-overlay 方案而不是 contenteditable：选中命令由 react-mentions
 * 渲染为整块 mention；textarea 只保存纯文本，Backspace/Delete 由库按 mention 边界处理。
 * 一个文本框可插入任意多个 `/` 命令，方向键导航由库的 suggestion 列表负责。
 */
export function MentionComposer({
  value,
  onChange,
  commands: rawCommands,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  disabled = false,
  autoFocus = false,
  onSubmit,
  onSubmitImmediate,
  onLayout,
}: {
  /** 纯文本草稿；命令在内部 markup 中保存，对父组件仍暴露纯文本。 */
  readonly value: string;
  /** 每次编辑后的纯文本；命令 token 仍保留在文本中，供 Engine 识别。 */
  readonly onChange: (text: string) => void;
  /** 当前可用的斜杠命令；由 App 的 ACP 目录事件构建。 */
  readonly commands?: readonly import("../types").LeadAvailableCommand[];
  readonly placeholder?: string;
  readonly ariaLabel: string;
  /** 草稿锁定时关联说明元素；与原生 textarea 行为一致。 */
  readonly ariaDescribedBy?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  /** Cmd/Ctrl+Enter 发送。 */
  readonly onSubmit: () => void;
  /** Ctrl+S 立即发送；未提供时不注册该快捷键。 */
  readonly onSubmitImmediate?: () => void;
  /** 输入框实际高度变化；用于历史区滚动偏移。 */
  readonly onLayout?: () => void;
}) {
  const commands = buildComposerSlashCommands(rawCommands ?? []);
  const [markup, setMarkup] = useState(() => plainToMarkup(value, commands));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastPlain = useRef(value);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  // 父级切换草稿或发送后清空时同步；本组件自身编辑产生的 value 更新由 lastPlain 拦截。
  useEffect(() => {
    if (value === lastPlain.current) return;
    lastPlain.current = value;
    setMarkup(plainToMarkup(value, commandsRef.current));
  }, [value]);

  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    // 先用 auto 量内容高度：不要归零，否则每次按键都会让浏览器先按 0 高度排版一次，
    // 滚动位置会被拉回顶部。限高在外层 control 上，textarea 自身永远不滚动。
    input.style.height = "auto";
    const contentHeight = input.scrollHeight;
    input.style.height = `${contentHeight}px`;
    // 高亮层是覆盖层，必须和被覆盖的文本同宽同高；滚动由外层 control 承担，
    // 两层一起位移，mention 才不会和正文错行（下拉回弹时也不会把下方文字漏出来）。
    const highlighter = input.parentElement?.querySelector<HTMLElement>(".composer-mentions__highlighter") ?? null;
    if (highlighter) {
      highlighter.style.width = `${input.clientWidth}px`;
      highlighter.style.height = `${contentHeight}px`;
    }
    onLayout?.();
  }, [onLayout]);

  useLayoutEffect(() => {
    resize();
  }, [markup, resize]);

  const mentionData: MentionDatum[] = commands.map((command) => ({
    id: command.token,
    // 尾随空格属于 mention 本身：显示上留出自然间距，Backspace 仍整条删除。
    display: `${"\u00A0".repeat(4)}${command.token}\u00A0\u00A0`,
    description: command.description,
    inputHint: command.inputHint,
  }));
  const search: DataFunc = (query, callback) => {
    const needle = query.trim().toLowerCase();
    callback(needle
      ? mentionData.filter((item) => `${item.display ?? ""} ${item.description}`.toLowerCase().includes(needle))
      : mentionData);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (isSubmit(event) && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (
      onSubmitImmediate &&
      event.key.toLowerCase() === "s" &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onSubmitImmediate();
    }
  };

  return (
    <MentionsInput
      value={markup}
      onChange={(_event, nextMarkup, plainText, mentions) => {
        const engineText = engineTextFromMentions(plainText, mentions);
        lastPlain.current = engineText;
        setMarkup(nextMarkup);
        onChange(engineText);
      }}
      onKeyDown={handleKeyDown}
      inputRef={inputRef}
      className="composer-mentions"
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      autoFocus={autoFocus}
      allowSuggestionsAboveCursor
      forceSuggestionsAboveCursor
      a11ySuggestionsListLabel="斜杠命令"
    >
      <Mention
        trigger="/"
        data={search}
        markup="@[__display__](__id__)"
        isLoading={false}
        className="composer-mentions__mention"
        style={{ background: "var(--wf-input)", color: "var(--wf-accent-strong)", WebkitTextStroke: "0.45px var(--wf-accent-strong)", visibility: "visible" }}
        displayTransform={(_id, display) => display.replace(/^(\s*)\//, "$1")}
        appendSpaceOnAdd={false}
        renderSuggestion={(suggestion) => {
          const item = suggestion as MentionDatum;
          return (
            <div className="composer-mention-suggestion">
              <code>{item.display?.trim()}</code>
              <span>{item.description}</span>
              {item.inputHint && <small>{item.inputHint}</small>}
            </div>
          );
        }}
      />
    </MentionsInput>
  );
}
