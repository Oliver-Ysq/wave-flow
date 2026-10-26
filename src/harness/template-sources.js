// 内置预置受限源码的文本装载器。
//
// 为什么是 .js：模板脚本是受限草案形态（脚本、无 import/export、使用宿主注入的作者 API），
// TypeScript 一旦解析它们就会把它们并入主工程，并因注入全局不存在而报出假错误。
// 这里用 .js 让 TS 只看到同目录的 .d.ts 类型声明，而 Bun 的打包器仍按文本内嵌模板源码。
// 模板脚本本身由 src/harness/templates/tsconfig.json 单独类型检查。
import codeReview from "./templates/code-review.ts" with { type: "text" };
import deepResearch from "./templates/deep-research.ts" with { type: "text" };
import deepCr from "./templates/deep-cr.ts" with { type: "text" };

export const templateSources = {
  "code-review": codeReview,
  "deep-research": deepResearch,
  "deep-cr": deepCr,
};
