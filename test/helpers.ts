/**
 * 测试公用工具
 */
import { rm } from 'node:fs/promises';

function isBusy(e: unknown): boolean {
  const c = (e as NodeJS.ErrnoException)?.code;
  return c === 'EBUSY' || c === 'EPERM' || c === 'EACCES' || c === 'ENOTEMPTY';
}

/**
 * 删除目录，遇到 Windows 句柄释放延迟时重试。
 *
 * 引擎进程被终止后，data.db 等文件的句柄由系统异步回收，
 * 紧接着的 rm 会 EBUSY。测试清理必须重试，否则会得到假失败。
 */
/**
 * 删除临时目录，遇到 Windows 句柄释放延迟时重试；**最终失败不抛出**。
 *
 * 理由：引擎进程被终止后，data.db 的句柄由系统异步回收（本机还叠加了
 * Defender 的临时占用），临时目录偶尔删不干净。这是清理阶段的噪声，
 * 不代表被测行为有问题——断言早已在此之前完成，因此这里只告警不失败。
 * （产品代码里的敏感文件加密用严格版 retryBusy，失败会明确报错。）
 */
export async function rmRetry(
  path: string,
  opts: { recursive?: boolean; force?: boolean } = { recursive: true, force: true },
  attempts = 25,
  delayMs = 120,
): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true, ...opts });
      return;
    } catch (e) {
      last = e;
      if (!isBusy(e)) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  process.stderr.write(
    `[test-cleanup] 跳过未能删除的临时目录 ${path}: ${(last as Error)?.message ?? last}\n`,
  );
}
