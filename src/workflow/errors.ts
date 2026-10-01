/** Workflow 作者代码违反静态或运行时契约时抛出的错误；并发原语不得将其降级为业务 null。 */
export class WorkflowContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowContractError";
  }
}
