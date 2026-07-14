import type { NetworkRequestRecord } from "./network-capture-service.js";
import { DIO_DEFAULT_ISOLATE_THRESHOLD_BYTES, extractUrlPath } from "./network-aggregate.js";

export type ParseCostSource = "measured" | "estimate" | "mixed";

export interface ParsePathStat {
  path: string;
  method?: string;
  count: number;
  avgParseMs: number;
  totalParseMs: number;
  avgPostResponseMs?: number;
  totalBytes?: number;
  source: ParseCostSource;
}

const MEDIA_PATH =
  /\.(jpg|jpeg|png|gif|webp|svg|ico|mp4|mp3|woff|woff2|ttf|zip|apk)(\?|$)/i;

export function isMediaOrStaticAssetUri(uri: string): boolean {
  const lower = uri.toLowerCase();
  if (MEDIA_PATH.test(lower)) return true;
  if (lower.includes("/media/") && !lower.includes("/api/")) return true;
  if (lower.includes("@2x.") || lower.includes("@3x.")) return true;
  return false;
}

function isLikelyJsonApiRequest(r: NetworkRequestRecord): boolean {
  if (!r.uri?.startsWith("http")) return false;
  if (isMediaOrStaticAssetUri(r.uri)) return false;
  const method = (r.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH") {
    return true;
  }
  return false;
}

/** 响应体收完后到请求结束：主 isolate 侧 transform/解析/回调 */
export function computePostResponseMs(r: NetworkRequestRecord): number | undefined {
  if (r.postResponseMs != null && r.postResponseMs >= 0) {
    return Math.round(r.postResponseMs * 10) / 10;
  }
  return undefined;
}

export function aggregateParseCostByPath(
  requests: NetworkRequestRecord[],
  dioWorkerCpuMs = 0
): ParsePathStat[] {
  const apiRequests = requests.filter(isLikelyJsonApiRequest);
  if (apiRequests.length === 0) return [];

  const pathMap = new Map<
    string,
    {
      count: number;
      totalPostMs: number;
      postTimed: number;
      totalBytes: number;
      methodCounts: Map<string, number>;
    }
  >();

  for (const r of apiRequests) {
    const path = extractUrlPath(r.uri);
    const entry = pathMap.get(path) ?? {
      count: 0,
      totalPostMs: 0,
      postTimed: 0,
      totalBytes: 0,
      methodCounts: new Map<string, number>(),
    };
    entry.count += 1;
    const m = (r.method ?? "GET").toUpperCase();
    entry.methodCounts.set(m, (entry.methodCounts.get(m) ?? 0) + 1);
    const post = computePostResponseMs(r);
    if (post != null) {
      entry.totalPostMs += post;
      entry.postTimed += 1;
    }
    if (r.responseSize != null && r.responseSize > 0) {
      entry.totalBytes += r.responseSize;
    }
    pathMap.set(path, entry);
  }

  const totalBytesAll = [...pathMap.values()].reduce(
    (s, v) => s + v.totalBytes,
    0
  );
  const hasMeasured = apiRequests.some((r) => computePostResponseMs(r) != null);

  const stats: ParsePathStat[] = [...pathMap.entries()].map(([path, v]) => {
    let topMethod: string | undefined;
    let topMethodCount = 0;
    for (const [method, c] of v.methodCounts) {
      if (c > topMethodCount) {
        topMethodCount = c;
        topMethod = method;
      }
    }

    const avgPost =
      v.postTimed > 0
        ? Math.round((v.totalPostMs / v.postTimed) * 10) / 10
        : undefined;

    let workerShareMs = 0;
    if (dioWorkerCpuMs > 0) {
      const weight =
        totalBytesAll > 0
          ? v.totalBytes / totalBytesAll
          : v.count / apiRequests.length;
      workerShareMs = dioWorkerCpuMs * weight;
    }

    const measuredTotal = v.totalPostMs;
    const totalParseMs = Math.round((measuredTotal + workerShareMs) * 10) / 10;
    const avgParseMs =
      v.count > 0
        ? Math.round((totalParseMs / v.count) * 10) / 10
        : 0;

    let source: ParseCostSource = "estimate";
    if (hasMeasured && workerShareMs > 0) source = "mixed";
    else if (hasMeasured) source = "measured";
    else if (workerShareMs > 0) source = "estimate";

    return {
      path,
      method: topMethod,
      count: v.count,
      avgParseMs,
      totalParseMs,
      avgPostResponseMs: avgPost,
      totalBytes: v.totalBytes > 0 ? v.totalBytes : undefined,
      source,
    };
  });

  return stats
    .filter((s) => s.totalParseMs > 0 || s.avgPostResponseMs != null)
    .sort(
      (a, b) =>
        b.totalParseMs - a.totalParseMs ||
        b.avgParseMs - a.avgParseMs ||
        b.count - a.count
    )
    .slice(0, 8);
}

/** 旧 session JSON 无 per-request 明细时，用 Dio worker CPU + path 体积分摊 */
export function deriveParseTopFromLegacy(input: {
  topPaths?: Array<{
    path: string;
    method?: string;
    count: number;
    avgMs?: number;
    totalBytes?: number;
  }>;
  dioWorkerCpuMs?: number;
}): ParsePathStat[] {
  const paths = (input.topPaths ?? []).filter(
    (p) => !MEDIA_PATH.test(p.path) && !p.path.includes("/media/")
  );
  if (paths.length === 0) return [];

  const workerMs = input.dioWorkerCpuMs ?? 0;
  const totalBytes = paths.reduce((s, p) => s + (p.totalBytes ?? 0), 0);
  const totalCount = paths.reduce((s, p) => s + p.count, 0);

  return paths
    .map((p) => {
      const weight =
        totalBytes > 0 && (p.totalBytes ?? 0) > 0
          ? (p.totalBytes ?? 0) / totalBytes
          : totalCount > 0
            ? p.count / totalCount
            : 1 / paths.length;
      const totalParseMs = Math.round(workerMs * weight * 10) / 10;
      const avgParseMs =
        p.count > 0
          ? Math.round((totalParseMs / p.count) * 10) / 10
          : 0;
      return {
        path: p.path,
        method: p.method,
        count: p.count,
        avgParseMs,
        totalParseMs,
        totalBytes: p.totalBytes,
        source: "estimate" as const,
      };
    })
    .filter((s) => s.totalParseMs > 0 || s.avgParseMs > 0)
    .sort((a, b) => b.totalParseMs - a.totalParseMs)
    .slice(0, 8);
}

export function formatBytesKb(bytes?: number): string {
  if (bytes == null || bytes <= 0) return "-";
  const kb = Math.round((bytes / 1024) * 10) / 10;
  return kb >= 1024 ? `${Math.round((kb / 1024) * 10) / 10}MB` : `${kb}KB`;
}

export function parseSourceLabel(source: ParseCostSource): string {
  if (source === "measured") return "HttpProfile";
  if (source === "mixed") return "HttpProfile+Worker";
  return "Worker分摊";
}
