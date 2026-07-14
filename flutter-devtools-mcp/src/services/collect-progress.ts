/** 采集阶段进度（stderr / MCP 返回均可展示） */
export type CollectProgressFn = (message: string) => void;

export const DEFAULT_PROGRESS: CollectProgressFn = (message) => {
  process.stderr.write(`[perf] ${message}\n`);
};

export async function sleepWithProgress(
  totalSec: number,
  label: string,
  onProgress: CollectProgressFn,
  tickSec = 10
): Promise<void> {
  if (totalSec <= 0) return;
  onProgress(`${label} 0/${totalSec}s（请在 App 内操作目标场景）`);
  let elapsed = 0;
  while (elapsed < totalSec) {
    const step = Math.min(tickSec, totalSec - elapsed);
    await new Promise((r) => setTimeout(r, step * 1000));
    elapsed += step;
    onProgress(`${label} ${elapsed}/${totalSec}s…`);
  }
}

export function formatCollectEta(
  recordingWindowSec: number,
  enableMemory = false
): string {
  const note = enableMemory
    ? "Timeline/CPU/内存/报告，Android 真机偏慢"
    : "Timeline/CPU/报告（未采内存），Android 真机偏慢";
  return (
    `预计总耗时约 ${recordingWindowSec + (enableMemory ? 30 : 15)}～${recordingWindowSec + (enableMemory ? 120 : 90)}s：` +
    `录制 ${recordingWindowSec}s + 收尾（${note}）`
  );
}
