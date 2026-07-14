import type { PerformanceSessionResult } from "./session-types.js";
import type { NetworkRequestRecord } from "./network-capture-service.js";
import { enrichRebuildsWithBusiness } from "./rebuild-business-resolver.js";
import { sanitizeSessionCpuTops } from "./cpu-symbol-filter.js";
import { deriveParseTopFromLegacy } from "./json-parse-aggregate.js";
import { deriveThresholdAlertsFromLegacy } from "./threshold-alerts.js";

/** Dio 5.9 默认：响应体 >= 50KB 时在后台 isolate 做 utf8+json 解析 */
export const DIO_DEFAULT_ISOLATE_THRESHOLD_BYTES = 50 * 1024;

export interface NetworkPathStat {
  path: string;
  /** 该 path 最常见 HTTP 方法 */
  method?: string;
  count: number;
  avgMs?: number;
  totalBytes?: number;
}

export interface NetworkAggregate {
  qps: number;
  completedWithTiming: number;
  avgMs?: number;
  /** 响应体 >= Dio 默认 isolate 阈值（50KB）的请求数 */
  largeJsonResponseCount: number;
  topPaths: NetworkPathStat[];
}

export interface DioJsonDecodeInsight {
  detected: true;
  source: "dio.FusedTransformer._decodeUtf8ToJson";
  isolateThresholdKb: number;
  workerCount: number;
  totalWorkerCpuMs: number;
  networkTotal: number;
  networkQps: number;
  largeJsonResponseCount: number;
  topPaths: NetworkPathStat[];
  suggestions: string[];
}

export function extractUrlPath(uri: string): string {
  try {
    const u = new URL(uri);
    const path = u.pathname || uri;
    return path.length > 72 ? `${path.slice(0, 69)}...` : path;
  } catch {
    return uri.length > 72 ? `${uri.slice(0, 69)}...` : uri;
  }
}

export function isDioJsonDecodeIsolate(name: string): boolean {
  return name.includes("_decodeUtf8ToJson");
}

export function aggregateNetworkRequests(
  requests: NetworkRequestRecord[],
  durationSec: number
): NetworkAggregate {
  const total = requests.length;
  const completed = requests.filter(
    (r) => r.endTime != null && r.startTime != null
  );
  const durations = completed.map((r) => r.endTime! - r.startTime);
  const avgMs =
    durations.length > 0
      ? Math.round(
          (durations.reduce((a, b) => a + b, 0) / durations.length) * 10
        ) / 10
      : undefined;

  const pathMap = new Map<
    string,
    {
      count: number;
      totalMs: number;
      timed: number;
      totalBytes: number;
      methodCounts: Map<string, number>;
    }
  >();
  let largeJsonResponseCount = 0;

  for (const r of requests) {
    if (!r.uri?.startsWith("http")) continue;
    const path = extractUrlPath(r.uri);
    const entry = pathMap.get(path) ?? {
      count: 0,
      totalMs: 0,
      timed: 0,
      totalBytes: 0,
      methodCounts: new Map<string, number>(),
    };
    entry.count += 1;
    const m = (r.method ?? "GET").toUpperCase();
    entry.methodCounts.set(m, (entry.methodCounts.get(m) ?? 0) + 1);
    if (r.endTime != null && r.startTime != null) {
      entry.totalMs += r.endTime - r.startTime;
      entry.timed += 1;
    }
    if (r.responseSize != null && r.responseSize > 0) {
      entry.totalBytes += r.responseSize;
      if (r.responseSize >= DIO_DEFAULT_ISOLATE_THRESHOLD_BYTES) {
        largeJsonResponseCount += 1;
      }
    }
    pathMap.set(path, entry);
  }

  const topPaths = [...pathMap.entries()]
    .map(([path, v]) => {
      let topMethod: string | undefined;
      let topMethodCount = 0;
      for (const [method, c] of v.methodCounts) {
        if (c > topMethodCount) {
          topMethodCount = c;
          topMethod = method;
        }
      }
      return {
        path,
        method: topMethod,
        count: v.count,
        avgMs:
          v.timed > 0
            ? Math.round((v.totalMs / v.timed) * 10) / 10
            : undefined,
        totalBytes: v.totalBytes > 0 ? v.totalBytes : undefined,
      };
    })
    .sort((a, b) => b.count - a.count || (b.totalBytes ?? 0) - (a.totalBytes ?? 0))
    .slice(0, 5);

  const qps =
    durationSec > 0 ? Math.round((total / durationSec) * 10) / 10 : 0;

  return {
    qps,
    completedWithTiming: completed.length,
    avgMs,
    largeJsonResponseCount,
    topPaths,
  };
}

export function buildDioJsonDecodeInsight(input: {
  isolateCpu: Array<{
    name: string;
    isMain: boolean;
    topSelfMs: number;
  }>;
  networkTotal: number;
  durationSec: number;
  aggregate: NetworkAggregate;
}): DioJsonDecodeInsight | undefined {
  const workers = input.isolateCpu.filter(
    (i) => !i.isMain && isDioJsonDecodeIsolate(i.name)
  );
  if (workers.length === 0) return undefined;

  const totalWorkerCpuMs =
    Math.round(workers.reduce((s, w) => s + w.topSelfMs, 0) * 10) / 10;
  const thresholdKb = DIO_DEFAULT_ISOLATE_THRESHOLD_BYTES / 1024;
  const suggestions: string[] = [];

  suggestions.push(
    `Dio 默认 FusedTransformer：JSON 响应体 ≥${thresholdKb}KB 会在后台 isolate 解析（_decodeUtf8ToJson）。`
  );

  if (input.aggregate.largeJsonResponseCount > 0) {
    suggestions.push(
      `采集窗口内 ${input.aggregate.largeJsonResponseCount} 个响应 ≥${thresholdKb}KB，会触发后台解析；优先看 Top 路径是否可缓存/合并/缩小 payload。`
    );
  } else if (input.networkTotal > 0) {
    suggestions.push(
      `未统计到 ≥${thresholdKb}KB 响应（可能缺 content-length）；高并发小 JSON 仍可能触发 isolate，检查是否自定义 contentLengthIsolateThreshold=0。`
    );
  }

  if (input.aggregate.qps >= 1) {
    suggestions.push(
      `HTTP 约 ${input.aggregate.qps} req/s（${input.networkTotal} 次 / ${input.durationSec}s）；高频接口考虑节流、去重、ETag/本地缓存。`
    );
  }

  if (workers.length >= 4) {
    suggestions.push(
      `${workers.length} 个 Dio 解析 worker 并行，累计 CPU ~${totalWorkerCpuMs}ms；与 GC/内存压力相关，避免滚动/切页高峰同时拉大量列表接口。`
    );
  }

  if (input.aggregate.topPaths.length > 0) {
    suggestions.unshift(
      "接口明细见报告「解析耗时 Top」表；优先排查高频 path 的 payload 体积、并发与缓存/去重。"
    );
  } else if (input.networkTotal > 0) {
    suggestions.unshift(
      "已统计到 HTTP 次数但未解析出 URL path，请确认 App 走 dart:io HttpClient（Dio IOHttpClientAdapter）且 ext.dart.io.getHttpProfile 可用。"
    );
  }

  suggestions.push(
    "小响应可在 Dio 使用 FusedTransformer.sync() 或提高 contentLengthIsolateThreshold，减少 isolate 调度开销。"
  );

  return {
    detected: true,
    source: "dio.FusedTransformer._decodeUtf8ToJson",
    isolateThresholdKb: thresholdKb,
    workerCount: workers.length,
    totalWorkerCpuMs,
    networkTotal: input.networkTotal,
    networkQps: input.aggregate.qps,
    largeJsonResponseCount: input.aggregate.largeJsonResponseCount,
    topPaths: input.aggregate.topPaths,
    suggestions,
  };
}

export function enrichPerformanceSession(
  result: PerformanceSessionResult,
  options: { projectRoot?: string } = {}
): PerformanceSessionResult {
  const requests: NetworkRequestRecord[] = [];
  const aggregate = aggregateNetworkRequests(
    requests,
    result.recordingWindowSec ?? result.durationSec
  );
  // 旧 JSON 无 per-request 明细时，至少用 total 估算 qps
  if (result.network.total > 0 && aggregate.qps === 0) {
    const rec = result.recordingWindowSec ?? result.durationSec;
    aggregate.qps =
      rec > 0 ? Math.round((result.network.total / rec) * 10) / 10 : 0;
  }
  const network = {
    ...result.network,
    qps: result.network.qps ?? aggregate.qps,
    avgMs: result.network.avgMs ?? aggregate.avgMs,
    largeJsonResponseCount:
      result.network.largeJsonResponseCount ?? aggregate.largeJsonResponseCount,
    topPaths: result.network.topPaths ?? aggregate.topPaths,
  };
  const dioJsonDecode =
    result.dioJsonDecode ??
    buildDioJsonDecodeInsight({
      isolateCpu: result.isolateCpu ?? [],
      networkTotal: network.total,
      durationSec: result.recordingWindowSec ?? result.durationSec,
      aggregate: { ...aggregate, qps: network.qps ?? aggregate.qps },
    });
  const topParsePaths =
    result.network.topParsePaths ??
    deriveParseTopFromLegacy({
      topPaths: network.topPaths,
      dioWorkerCpuMs: dioJsonDecode?.totalWorkerCpuMs,
    });
  const networkWithParse = { ...network, topParsePaths };
  const thresholdAlerts =
    result.thresholdAlerts ??
    deriveThresholdAlertsFromLegacy({
      ...result,
      network: networkWithParse,
    });
  const topRebuilds =
    options.projectRoot && result.topRebuilds.length > 0
      ? enrichRebuildsWithBusiness(result.topRebuilds, {
          projectRoot: options.projectRoot,
          hintPaths: result.filesToInspect ?? [],
        })
      : result.topRebuilds;
  return sanitizeSessionCpuTops({
    ...result,
    network: networkWithParse,
    dioJsonDecode,
    topRebuilds,
    thresholdAlerts,
  });
}

export function formatNetworkPathStat(p: NetworkPathStat): string {
  const label = p.method ? `${p.method} ${p.path}` : p.path;
  const parts = [`${label} ×${p.count}`];
  if (p.avgMs != null) parts.push(`avg ${p.avgMs}ms`);
  if (p.totalBytes != null && p.totalBytes > 0) {
    const kb = Math.round((p.totalBytes / 1024) * 10) / 10;
    parts.push(`${kb}KB`);
  }
  return parts.join(", ");
}
