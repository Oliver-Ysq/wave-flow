import { LocalDaemon } from "./local-daemon";

/** 在单条 CLI 命令期间启动 loopback daemon，并在操作结束后确保释放端口。 */
export async function withLocalDaemon<T>(callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const daemon = new LocalDaemon();
  const server = daemon.start();
  try { return await callback(server.baseUrl); } finally { server.stop(); }
}
