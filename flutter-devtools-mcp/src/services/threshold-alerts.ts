import type { NetworkRequestRecord } from "./network-capture-service.js";
import type { PerformanceSessionResult } from "./session-types.js";
import {
  DEFAULT_PERFORMANCE_THRESHOLDS,
  type PerformanceThresholdConfig,
} from "./performance-thresholds.js";
import {
  aggregateParseCostByPath,
  deriveParseTopFromLegacy,
  formatBytesKb,
  isMediaOrStaticAssetUri,
  type ParsePathStat,
} from "./json-parse-aggregate.js";
import { extractUrlPath } from "./network-aggregate.js";

export interface LargeImageAlert {
  url: string;
  path: string;
  bytes?: number;
  width?: number;
  height?: number;
  decodeMs?: number;
  httpMs?: number;
  /** 命中哪些阈值，如「体积≥200KB」「解码≥16ms」 */
  triggers: string[];
  source: "timeline" | "http" | "both";
}

export interface LargeApiAlert {
  method?: string;
  path: string;
  count: number;
  bytes?: number;
  avgBytes?: number;
  avgParseMs: number;
  totalParseMs: number;
  triggers: string[];
  parseSource?: ParsePathStat["source"];
}

export interface ThresholdAlerts {
  config: PerformanceThresholdConfig;
  summary: {
    largeImageHits: number;
    slowDecodeHits: number;
    largeApiHits: number;
    slowParseHits: number;
  };
  largeImages: LargeImageAlert[];
  largeApis: LargeApiAlert[];
}

function shortUrlPath(uri: string): string {
  try {
    const u = new URL(uri);
    const p = u.pathname + (u.search || "");
    return p.length > 72 ? `${p.slice(0, 69)}...` : p;
  } catch {
    return uri.length > 72 ? `${uri.slice(0, 69)}...` : uri;
  }
}

function isImageRequest(r: NetworkRequestRecord): boolean {
  return isMediaOrStaticAssetUri(r.uri);
}

function triggerLargeImageBytes(
  bytes: number | undefined,
  cfg: PerformanceThresholdConfig
): string | undefined {
  if (bytes != null && bytes >= cfg.largeImageBytes) {
    return `体积≥${Math.round(cfg.largeImageBytes / 1024)}KB`;
  }
  return undefined;
}

function triggerSlowDecode(
  ms: number | undefined,
  cfg: PerformanceThresholdConfig
): string | undefined {
  if (ms != null && ms >= cfg.slowImageDecodeMs) {
    return `解码≥${cfg.slowImageDecodeMs}ms`;
  }
  return undefined;
}

function triggerLargeApiBytes(
  bytes: number | undefined,
  cfg: PerformanceThresholdConfig
): string | undefined {
  if (bytes != null && bytes >= cfg.largeApiBytes) {
    return `体积≥${Math.round(cfg.largeApiBytes / 1024)}KB`;
  }
  return undefined;
}

function triggerSlowParse(
  ms: number | undefined,
  cfg: PerformanceThresholdConfig
): string | undefined {
  if (ms != null && ms >= cfg.slowApiParseMs) {
    return `解析≥${cfg.slowApiParseMs}ms`;
  }
  return undefined;
}

export function buildThresholdAlerts(input: {
  requests?: NetworkRequestRecord[];
  imageDecode?: PerformanceSessionResult["imageDecode"];
  parsePaths?: ParsePathStat[];
  dioWorkerCpuMs?: number;
  config?: PerformanceThresholdConfig;
}): ThresholdAlerts {
  const cfg = input.config ?? DEFAULT_PERFORMANCE_THRESHOLDS;
  const requests = input.requests ?? [];
  const parsePaths =
    input.parsePaths ??
    aggregateParseCostByPath(requests, input.dioWorkerCpuMs ?? 0);

  const imageByUrl = new Map<string, LargeImageAlert>();

  for (const r of requests) {
    if (!isImageRequest(r)) continue;
    const httpMs =
      r.endTime != null && r.startTime != null
        ? r.endTime - r.startTime
        : undefined;
    const triggers: string[] = [];
    const tSize = triggerLargeImageBytes(r.responseSize, cfg);
    if (tSize) triggers.push(tSize);

    if (triggers.length === 0) continue;

    const url = r.uri;
    const existing = imageByUrl.get(url);
    const item: LargeImageAlert = {
      url,
      path: shortUrlPath(url),
      bytes: r.responseSize ?? existing?.bytes,
      decodeMs: existing?.decodeMs,
      httpMs: httpMs ?? existing?.httpMs,
      width: existing?.width,
      height: existing?.height,
      triggers: [...new Set([...(existing?.triggers ?? []), ...triggers])],
      source: existing?.source === "timeline" ? "both" : "http",
    };
    imageByUrl.set(url, item);
  }

  for (const s of input.imageDecode?.slow ?? []) {
    if (!s.url && s.ms <= 0) continue;
    const url = s.url ?? `timeline:${s.name}`;
    const existing = imageByUrl.get(url);
    const triggers = [...(existing?.triggers ?? [])];
    const tDecode = triggerSlowDecode(s.ms, cfg);
    if (tDecode) triggers.push(tDecode);
    const tSize = triggerLargeImageBytes(s.bytes, cfg);
    if (tSize) triggers.push(tSize);

    if (triggers.length === 0 && s.ms < cfg.slowImageDecodeMs) continue;

    const mergedTriggers =
      triggers.length > 0
        ? [...new Set(triggers)]
        : [triggerSlowDecode(s.ms, cfg)!].filter(Boolean);

    imageByUrl.set(url, {
      url: s.url ?? url,
      path: s.url ? shortUrlPath(s.url) : s.name,
      bytes: s.bytes ?? existing?.bytes,
      width: s.width ?? existing?.width,
      height: s.height ?? existing?.height,
      decodeMs: s.ms,
      httpMs: existing?.httpMs,
      triggers: mergedTriggers,
      source: existing?.source === "http" ? "both" : "timeline",
    });
  }

  const largeImages = [...imageByUrl.values()]
    .filter((i) => i.triggers.length > 0)
    .sort(
      (a, b) =>
        (b.decodeMs ?? 0) - (a.decodeMs ?? 0) ||
        (b.bytes ?? 0) - (a.bytes ?? 0) ||
        (b.httpMs ?? 0) - (a.httpMs ?? 0)
    )
    .slice(0, 10);

  const apiByPath = new Map<string, LargeApiAlert>();

  for (const p of parsePaths) {
    const avgBytes =
      p.totalBytes != null && p.count > 0
        ? Math.round(p.totalBytes / p.count)
        : undefined;
    const triggers: string[] = [];
    const tParse = triggerSlowParse(p.avgParseMs, cfg);
    if (tParse) triggers.push(tParse);
    const tSize = triggerLargeApiBytes(avgBytes, cfg);
    if (tSize) triggers.push(tSize);
    const tTotal = triggerLargeApiBytes(p.totalBytes, cfg);
    if (tTotal && !triggers.includes(tTotal)) triggers.push(tTotal);

    if (triggers.length === 0) continue;

    apiByPath.set(p.path, {
      method: p.method,
      path: p.path,
      count: p.count,
      bytes: p.totalBytes,
      avgBytes,
      avgParseMs: p.avgParseMs,
      totalParseMs: p.totalParseMs,
      triggers,
      parseSource: p.source,
    });
  }

  for (const r of requests) {
    if (isImageRequest(r)) continue;
    if (!isLikelyApiUri(r.uri)) continue;
    const path = extractUrlPath(r.uri);
    if (apiByPath.has(path)) continue;
    const triggers: string[] = [];
    const tSize = triggerLargeApiBytes(r.responseSize, cfg);
    if (tSize) triggers.push(tSize);
    if (triggers.length === 0) continue;
    apiByPath.set(path, {
      method: r.method,
      path,
      count: 1,
      bytes: r.responseSize,
      avgBytes: r.responseSize,
      avgParseMs: 0,
      totalParseMs: 0,
      triggers,
    });
  }

  const largeApis = [...apiByPath.values()]
    .sort(
      (a, b) =>
        b.totalParseMs - a.totalParseMs ||
        (b.avgBytes ?? 0) - (a.avgBytes ?? 0) ||
        b.count - a.count
    )
    .slice(0, 10);

  const largeImageHits = largeImages.filter((i) =>
    i.triggers.some((t) => t.startsWith("体积"))
  ).length;
  const slowDecodeHits = largeImages.filter((i) =>
    i.triggers.some((t) => t.startsWith("解码"))
  ).length;
  const largeApiHits = largeApis.filter((i) =>
    i.triggers.some((t) => t.startsWith("体积"))
  ).length;
  const slowParseHits = largeApis.filter((i) =>
    i.triggers.some((t) => t.startsWith("解析"))
  ).length;

  return {
    config: cfg,
    summary: {
      largeImageHits,
      slowDecodeHits,
      largeApiHits,
      slowParseHits,
    },
    largeImages,
    largeApis,
  };
}

function isLikelyApiUri(uri: string): boolean {
  return uri.startsWith("http") && !isMediaOrStaticAssetUri(uri);
}

/** 旧 JSON：用 slow / topPaths / topParsePaths / imageDecode 还原超阈值项 */
export function deriveThresholdAlertsFromLegacy(
  result: PerformanceSessionResult,
  config?: PerformanceThresholdConfig
): ThresholdAlerts {
  const cfg = config ?? DEFAULT_PERFORMANCE_THRESHOLDS;
  const parsePaths =
    result.network.topParsePaths ??
    deriveParseTopFromLegacy({
      topPaths: result.network.topPaths,
      dioWorkerCpuMs: result.dioJsonDecode?.totalWorkerCpuMs,
    });

  const pseudoRequests: NetworkRequestRecord[] = [];

  for (const s of result.network.slow ?? []) {
    if (!isMediaOrStaticAssetUri(s.url)) continue;
    pseudoRequests.push({
      id: s.url,
      method: s.method,
      uri: s.url,
      startTime: 0,
      endTime: s.ms,
      responseSize: undefined,
    });
  }

  for (const p of result.network.topPaths ?? []) {
    if (isMediaOrStaticAssetUri(p.path)) {
      pseudoRequests.push({
        id: p.path,
        method: p.method ?? "GET",
        uri: `https://local${p.path}`,
        startTime: 0,
        responseSize: p.totalBytes,
      });
    }
  }

  const alerts = buildThresholdAlerts({
    requests: pseudoRequests,
    imageDecode: result.imageDecode,
    parsePaths,
    dioWorkerCpuMs: result.dioJsonDecode?.totalWorkerCpuMs,
    config: cfg,
  });

  // slow 图片无 content-length 时：HTTP 极慢也视为「大/慢图片」检测命中
  for (const s of result.network.slow ?? []) {
    if (!isMediaOrStaticAssetUri(s.url)) continue;
    if (alerts.largeImages.some((i) => i.url === s.url)) continue;
    if (s.ms < 3000) continue;
    let path = s.url;
    try {
      path = shortUrlPath(s.url);
    } catch {
      /* keep */
    }
    alerts.largeImages.push({
      url: s.url,
      path,
      httpMs: s.ms,
      triggers: [`HTTP≥3000ms（未测体积，疑似大图/慢网）`],
      source: "http",
    });
  }

  alerts.largeImages.sort(
    (a, b) =>
      (b.decodeMs ?? 0) - (a.decodeMs ?? 0) ||
      (b.httpMs ?? 0) - (a.httpMs ?? 0) ||
      (b.bytes ?? 0) - (a.bytes ?? 0)
  );
  alerts.largeImages.splice(10);

  alerts.summary.largeImageHits = alerts.largeImages.filter((i) =>
    i.triggers.some((t) => t.startsWith("体积") || t.startsWith("HTTP"))
  ).length;
  alerts.summary.slowDecodeHits = alerts.largeImages.filter((i) =>
    i.triggers.some((t) => t.startsWith("解码"))
  ).length;

  return alerts;
}

export { formatBytesKb };
