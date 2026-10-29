// 内置预置模块源码的文本装载器。
//
// 为什么是 .js：模板是独立作者模块，若被主工程直接 include 会把模板依赖并入普通编译；
// 这里用 .js 让 TS 只看到同目录声明，而 Bun 的打包器仍按文本内嵌模板源码。
// 模板模块本身由 src/harness/templates/tsconfig.json 单独类型检查。
import codeReview from "./templates/code-review.ts" with { type: "text" };
import deepResearch from "./templates/deep-research.ts" with { type: "text" };
import deepCr from "./templates/deep-cr.ts" with { type: "text" };

export const templateSources = {
  "code-review": codeReview,
  "deep-research": deepResearch,
  "deep-cr": deepCr,
};
