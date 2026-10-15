import { useEffect, useState } from "react";
import {
  coerceValue,
  initialValueFor,
  isSupportedSchema,
  validateAnswer,
  type SchemaFieldError,
} from "./schema-support";

/** 单个字段的受控渲染；path 为点分路径，用于错误定位与嵌套取值。 */
function SchemaField({
  name,
  schema,
  required,
  value,
  error,
  onChange,
}: {
  /** 字段名（properties 的 key）。 */
  name: string;
  /** 该字段的 Schema 节点（已确认在支持子集内）。 */
  schema: Record<string, unknown>;
  /** 是否父对象 required。 */
  required: boolean;
  /** 当前受控值。 */
  value: unknown;
  /** 校验失败时的字段级错误；无则为 null。 */
  error: string | null;
  /** 更新字段值。 */
  onChange: (value: unknown) => void;
}) {
  const label = (
    <span className="wf-field-label">
      {name}
      {required && <i title="必填">*</i>}
    </span>
  );
  let control: React.ReactNode;
  if (schema.type === "boolean") {
    // 布尔渲染为是/否分段按钮：原生 <select> 在 WKWebView 中既难键盘操作也读不出状态。
    control = (
      <div className="wf-segmented" role="radiogroup" aria-label={name}>
        {[true, false].map((option) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={value === option ? "selected" : undefined}
            onClick={() => onChange(option)}
          >
            {option ? "是" : "否"}
          </button>
        ))}
      </div>
    );
  } else if (Array.isArray(schema.enum) && schema.enum.length <= 4) {
    // 少量枚举用单选组，键盘与读屏均可达；更多选项仍用下拉。
    control = (
      <div className="wf-segmented" role="radiogroup" aria-label={name}>
        {(schema.enum as unknown[]).map((option) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={value === option ? "selected" : undefined}
            onClick={() => onChange(option)}
          >
            {String(option)}
          </button>
        ))}
      </div>
    );
  } else if (Array.isArray(schema.enum)) {
    control = (
      <select
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") onChange("");
          else if (schema.type === "number" || schema.type === "integer") onChange(Number(raw));
          else if (schema.type === "boolean") onChange(raw === "true");
          else onChange(raw);
        }}
      >
        <option value="">请选择</option>
        {(schema.enum as unknown[]).map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "number" || schema.type === "integer") {
    control = (
      <input
        type="number"
        step={schema.type === "integer" ? 1 : "any"}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else if (schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const requiredKeys = new Set((schema.required as string[] | undefined) ?? []);
    const objectValue = (value ?? {}) as Record<string, unknown>;
    control = (
      <fieldset className="wf-field-group">
        {Object.entries(properties).map(([key, child]) => (
          <SchemaField
            key={key}
            name={key}
            schema={child}
            required={requiredKeys.has(key)}
            value={objectValue[key]}
            error={null}
            onChange={(next) => onChange({ ...objectValue, [key]: next })}
          />
        ))}
      </fieldset>
    );
  } else {
    control = (
      <input
        type="text"
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <label className={`wf-schema-field ${error ? "invalid" : ""}`}>
      {label}
      {typeof schema.description === "string" && <small className="wf-field-description">{schema.description}</small>}
      {control}
      {error && <small className="wf-field-error">{error}</small>}
    </label>
  );
}

/**
 * 共用 Schema 表单：只渲染支持子集（标量/enum/嵌套 object）。
 * 不支持的 Schema 明确提示并禁用提交，绝不退回裸 JSON 输入；
 * 校验失败定位到字段且保留输入值。
 */
export function SchemaForm({
  schema,
  busy,
  submitLabel = "提交",
  onSubmit,
}: {
  /** 决策/决策门的 answerSchema（已在调用前确认存在）。 */
  schema: Record<string, unknown>;
  /** 提交中禁用表单。 */
  busy: boolean;
  /** 提交按钮文案。 */
  submitLabel?: string;
  /** 校验通过后的提交回调；抛错时错误展示在表单底部。 */
  onSubmit: (value: Record<string, unknown>) => Promise<void>;
}) {
  const schemaIdentity=JSON.stringify(schema);
  const support = isSupportedSchema(schema);
  const [value, setValue] = useState<Record<string, unknown>>(() =>
    support.supported && schema.type === "object"
      ? (initialValueFor(schema) as Record<string, unknown>)
      : {},
  );
  const [fieldErrors, setFieldErrors] = useState<SchemaFieldError[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(()=>{
    const next=isSupportedSchema(schema);
    setValue(next.supported&&schema.type==="object"?(initialValueFor(schema) as Record<string,unknown>):{});
    setFieldErrors([]);setSubmitError(null);
  },[schemaIdentity]);

  if (!support.supported || schema.type !== "object") {
    return (
      <div className="wf-schema-unsupported" role="note">
        该问题暂不支持表单回答{support.supported ? "（仅支持对象答案）" : `：${support.reason}`}
      </div>
    );
  }

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const requiredKeys = new Set((schema.required as string[] | undefined) ?? []);
  const errorFor = (key: string) =>
    fieldErrors.find((error) => error.path === key)?.message ?? null;

  async function submit() {
    const coerced = coerceValue(schema, value) as Record<string, unknown>;
    const errors = validateAnswer(schema, coerced);
    if (errors.length > 0) {
      setFieldErrors(errors);
      setSubmitError(null);
      return;
    }
    setFieldErrors([]);
    try {
      await onSubmit(coerced);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="wf-schema-form">
      {Object.entries(properties).map(([key, child]) => (
        <SchemaField
          key={key}
          name={key}
          schema={child}
          required={requiredKeys.has(key)}
          value={value[key]}
          error={errorFor(key)}
          onChange={(next) => setValue((current) => ({ ...current, [key]: next }))}
        />
      ))}
      {fieldErrors.some((error) => error.path === "") && (
        <p className="answer-error">
          {fieldErrors.find((error) => error.path === "")?.message}
        </p>
      )}
      <button disabled={busy} onClick={() => void submit()}>
        {busy ? "正在交付…" : submitLabel}
      </button>
      {submitError && <p className="answer-error">{submitError}</p>}
    </div>
  );
}
