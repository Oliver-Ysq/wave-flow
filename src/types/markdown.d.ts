/** Bun 的 Markdown / 纯文本 import 在类型层面声明为字符串；编译为单文件二进制时内容在构建期内嵌。 */
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}
