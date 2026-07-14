/** 大图片：响应体体积阈值（默认 200KB） */
export const LARGE_IMAGE_BYTES = 200 * 1024;

/** 图片解码慢：单帧预算 16.67ms @60FPS，取 16ms */
export const SLOW_IMAGE_DECODE_MS = 16;

/** 大接口 JSON：与 Dio FusedTransformer 默认 isolate 阈值对齐 */
export const LARGE_API_BYTES = 50 * 1024;

/** 单请求/均摊解析偏慢 */
export const SLOW_API_PARSE_MS = 8;

export interface PerformanceThresholdConfig {
  largeImageBytes: number;
  slowImageDecodeMs: number;
  largeApiBytes: number;
  slowApiParseMs: number;
}

export const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceThresholdConfig = {
  largeImageBytes: LARGE_IMAGE_BYTES,
  slowImageDecodeMs: SLOW_IMAGE_DECODE_MS,
  largeApiBytes: LARGE_API_BYTES,
  slowApiParseMs: SLOW_API_PARSE_MS,
};

export function formatThresholdBrief(c: PerformanceThresholdConfig): string {
  return (
    `图片≥${Math.round(c.largeImageBytes / 1024)}KB 或解码≥${c.slowImageDecodeMs}ms；` +
    `接口≥${Math.round(c.largeApiBytes / 1024)}KB 或解析≥${c.slowApiParseMs}ms`
  );
}
