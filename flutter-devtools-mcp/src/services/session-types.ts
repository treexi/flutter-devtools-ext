import { join } from "path";

export type Severity = "low" | "medium" | "high" | "critical";

/** 掉帧判定固定按 60FPS：单帧 > 16.67ms 计为 jank（不跟设备刷新率） */
export const JANK_TARGET_FPS = 60;
export const JANK_FRAME_BUDGET_MS = 1000 / JANK_TARGET_FPS; // ≈ 16.666…ms

/** 耗时函数（业务 lib/ Top）Self 超过该值判为异常 */
export const HOT_FUNCTION_ABNORMAL_MS = 20;

export interface PerformanceSessionResult {
  scenario: string;
  /** 兼容旧字段：等同 wallClockSec（从启动到报告完成的总墙钟时间） */
  durationSec: number;
  /** 实际录制窗口（warmup + durationSec 参数） */
  recordingWindowSec?: number;
  /** 总墙钟时间（含收尾分析） */
  wallClockSec?: number;
  progressLog?: string[];
  profileModeHint: string;
  frames: {
    total: number;
    jankCount: number;
    jankPct: number;
    avgMs: number;
    p99Ms: number;
    buildMaxMs: number;
    layoutMaxMs: number;
    paintMaxMs: number;
  };
  topFunctions: Array<{
    name: string;
    file: string;
    selfMs: number;
    pct: number;
    severity: Severity;
  }>;
  projectTopFunctions: Array<{
    name: string;
    file: string;
    selfMs: number;
    pct: number;
    severity: Severity;
  }>;
  /** VM / 引擎内部 CPU 热点（可读化，非业务 lib/） */
  vmTopFunctions?: Array<{
    name: string;
    rawName: string;
    file: string;
    selfMs: number;
    pct: number;
    severity: Severity;
  }>;
  topRebuilds: Array<{
    widget: string;
    file: string;
    line: number;
    count: number;
    severity: Severity;
    /** 业务侧定位（上级 Widget / 页面） */
    bizWidget?: string;
    bizFile?: string;
    bizLine?: number;
    bizSource?: "direct" | "runtime" | "static" | "inferred";
    /** 代码库内参考引用，非当前屏定位 */
    staticRefNote?: string;
  }>;
  memory: {
    /** false 表示未调用 getAllocationProfile（默认关闭以缩短收尾） */
    collected?: boolean;
    heapMb: number;
    utilizationPct: number;
    topClasses: Array<{ name: string; instances: number; bytesMb: number }>;
    suspicious: string[];
  };
  network: {
    total: number;
    errors: number;
    slow: Array<{ method: string; url: string; ms: number; status?: number }>;
    /** 请求频率 req/s */
    qps?: number;
    avgMs?: number;
    /** 响应体 >= Dio 默认 50KB 阈值 */
    largeJsonResponseCount?: number;
    topPaths?: Array<{
      path: string;
      method?: string;
      count: number;
      avgMs?: number;
      totalBytes?: number;
    }>;
    /** JSON/Transform 解析耗时 Top（非 HTTP 总耗时） */
    topParsePaths?: Array<{
      path: string;
      method?: string;
      count: number;
      avgParseMs: number;
      totalParseMs: number;
      avgPostResponseMs?: number;
      totalBytes?: number;
      source: "measured" | "estimate" | "mixed";
    }>;
  };
  /** Dio FusedTransformer 后台 JSON 解析与 HTTP 统计关联 */
  dioJsonDecode?: {
    detected: true;
    source: string;
    isolateThresholdKb: number;
    workerCount: number;
    totalWorkerCpuMs: number;
    networkTotal: number;
    networkQps: number;
    largeJsonResponseCount: number;
    topPaths: Array<{
      path: string;
      count: number;
      avgMs?: number;
      totalBytes?: number;
    }>;
    suggestions: string[];
  };
  /** GC 停顿（Timeline GC 流） */
  gc?: {
    count: number;
    totalPauseMs: number;
    maxPauseMs: number;
    avgPauseMs: number;
    longPauseCount: number;
    /** 最长停顿 Top5 */
    topPauses?: Array<{ name: string; ms: number }>;
  };
  /** 滚动/交互分段 FPS（2s 窗口） */
  scrollFps?: {
    segmentSec: number;
    overallFps: number;
    worstSegments: Array<{
      startSec: number;
      endSec: number;
      frames: number;
      fps: number;
      jankCount: number;
      jankPct: number;
      avgMs: number;
      maxMs: number;
    }>;
  };
  /** 图片解码粗统计 */
  imageDecode?: {
    count: number;
    totalMs: number;
    maxMs: number;
    slow: Array<{
      name: string;
      ms: number;
      url?: string;
      width?: number;
      height?: number;
      bytes?: number;
    }>;
    /** 有解码信号但无有效时长 */
    untimedSignals?: number;
  };
  /** 各 isolate CPU 采样对比 */
  isolateCpu?: Array<{
    isolateId: string;
    name: string;
    isMain: boolean;
    sampleCount: number;
    topSelfMs: number;
    topName: string;
  }>;
  /** 超阈值：大图片 / 大接口 + 解析或解码耗时 */
  thresholdAlerts?: {
    config: {
      largeImageBytes: number;
      slowImageDecodeMs: number;
      largeApiBytes: number;
      slowApiParseMs: number;
    };
    summary: {
      largeImageHits: number;
      slowDecodeHits: number;
      largeApiHits: number;
      slowParseHits: number;
    };
    largeImages: Array<{
      url: string;
      path: string;
      bytes?: number;
      width?: number;
      height?: number;
      decodeMs?: number;
      httpMs?: number;
      triggers: string[];
      source: "timeline" | "http" | "both";
    }>;
    largeApis: Array<{
      method?: string;
      path: string;
      count: number;
      bytes?: number;
      avgBytes?: number;
      avgParseMs: number;
      totalParseMs: number;
      triggers: string[];
      parseSource?: "measured" | "estimate" | "mixed";
    }>;
  };
  filesToInspect: string[];
  hintsForAnalysis: string[];
  aiNextStep: string;
  cpuProfileSource?: "vm-samples" | "timeline-dart" | "timeline-hotspot" | "none";
  aiAnalysis?: string;
}

export const PERFORMANCE_SESSIONS_DIR = "performance-sessions";

export function resolveSessionOutputDir(options: {
  outputDir?: string;
  projectRoot?: string;
}): string {
  if (options.outputDir) return options.outputDir;
  if (options.projectRoot) {
    return join(options.projectRoot, PERFORMANCE_SESSIONS_DIR);
  }
  return PERFORMANCE_SESSIONS_DIR;
}

export function severityFromRebuildCount(count: number): Severity {
  if (count > 100) return "critical";
  if (count > 30) return "high";
  if (count > 10) return "medium";
  return "low";
}

export function severityFromPct(pct: number): Severity {
  if (pct > 20) return "critical";
  if (pct > 10) return "high";
  if (pct > 5) return "medium";
  return "low";
}

/** Flutter / Dart SDK 与常见包，不算业务 App 源码 */
const NON_APP_PACKAGE_PREFIXES = [
  "package:flutter/",
  "package:flutter_test/",
  "package:flutter_localizations/",
  "package:flutter_web_plugins/",
  "package:sky_engine/",
  "package:collection/",
  "package:characters/",
  "package:vector_math/",
  "package:meta/",
  "package:async/",
  "package:path/",
  "package:stack_trace/",
  "dart:",
];

export function normalizeSourceFile(file: string): string {
  const raw = file.trim();
  if (!raw) return raw;

  // 已是 lib/... 相对路径
  if (raw.startsWith("lib/") || raw.startsWith("LIB/")) {
    return raw.replace(/^LIB\//, "lib/");
  }

  // package:app_name/path/under/lib.dart → lib/path/under/lib.dart
  const pkgMatch = raw.match(/^package:([^/]+)\/(.+)$/);
  if (pkgMatch) {
    const pkg = pkgMatch[1].toLowerCase();
    const pathInPkg = pkgMatch[2];
    // 仅精确匹配 SDK 包名，不要用 flutter_ 前缀误伤 flutter_simple 等业务包
    if (
      pkg === "flutter" ||
      pkg === "flutter_test" ||
      pkg === "flutter_localizations" ||
      pkg === "flutter_web_plugins" ||
      pkg === "sky_engine"
    ) {
      return `package:${pkgMatch[1]}/${pathInPkg}`;
    }
    if (pathInPkg.startsWith("lib/")) return pathInPkg;
    return `lib/${pathInPkg}`;
  }

  const cleaned = raw.replace(/^file:\/\//, "");
  const lower = cleaned.toLowerCase();

  // 排除 Flutter SDK 的 lib/，避免变成 lib/src/widgets/... 误判业务代码
  if (
    lower.includes("/packages/flutter/lib/") ||
    lower.includes("/bin/cache/pkg/sky_engine/") ||
    lower.includes("/sky_engine/")
  ) {
    const libIdx = cleaned.indexOf("/lib/");
    if (libIdx >= 0) {
      const afterLib = cleaned.slice(libIdx + "/lib/".length);
      if (lower.includes("/sky_engine/")) {
        return `package:sky_engine/${afterLib}`;
      }
      return `package:flutter/${afterLib}`;
    }
    return cleaned;
  }

  // Dart SDK / dart:ui：不要收成业务 lib/
  if (
    lower.includes("/dart-sdk/") ||
    lower.includes("/org-dartlang-sdk/") ||
    lower.includes("/lib/_internal/") ||
    lower.includes("/lib/developer/") ||
    lower.includes("/lib/async/") ||
    lower.includes("/lib/core/") ||
    lower.includes("/lib/io/") ||
    lower.includes("/lib/isolate/") ||
    lower.includes("/lib/ui/") ||
    /\/flutter\/bin\/cache\/artifacts\/engine\//.test(lower)
  ) {
    const libIdx = cleaned.indexOf("/lib/");
    if (libIdx >= 0) {
      const after = cleaned.slice(libIdx + "/lib/".length);
      if (after.startsWith("ui/") || after === "ui.dart") {
        return `dart:ui/${after.replace(/^ui\//, "")}`;
      }
      return `dart:${after}`;
    }
    return cleaned;
  }

  const libIdx = cleaned.indexOf("/lib/");
  if (libIdx >= 0) return cleaned.slice(libIdx + 1);
  return cleaned.split("/").pop() ?? cleaned;
}

export function isFrameworkOrSdkFile(file: string): boolean {
  const f = file.toLowerCase().replace(/^file:\/\//, "");
  if (NON_APP_PACKAGE_PREFIXES.some((p) => f.startsWith(p))) return true;
  if (f.includes("/packages/flutter/") || f.includes("/sky_engine/")) return true;

  // 精确匹配 SDK package，避免 package:flutter_simple 被误判
  if (
    f.startsWith("package:flutter/") ||
    f.startsWith("package:flutter_test/") ||
    f.startsWith("package:flutter_localizations/") ||
    f.startsWith("package:flutter_web_plugins/") ||
    f.startsWith("package:sky_engine/")
  ) {
    return true;
  }

  // 历史误归一：Flutter SDK 被收成 lib/src/widgets|rendering|scheduler/...
  if (
    /^lib\/src\/(widgets|rendering|scheduler|painting|gestures|services|foundation|material|cupertino|animation)\//.test(
      f
    )
  ) {
    return true;
  }
  // Dart SDK / dart:ui / dart:_http / dart:internal 误归一
  if (
    /^lib\/(developer|async|collection|convert|core|io|isolate|math|typed_data|_internal|ui|_http|internal)\//.test(
      f
    ) ||
    f.includes("lib/_internal/") ||
    f.includes("lib/_http/") ||
    f.includes("lib/internal/") ||
    f.startsWith("dart:")
  ) {
    return true;
  }
  return false;
}

export function isProjectSourceFile(file: string): boolean {
  const f = file.toLowerCase().replace(/^file:\/\//, "");
  if (!f || isFrameworkOrSdkFile(f)) return false;
  if (f.startsWith("lib/")) return true;
  if (f.startsWith("package:") && f.endsWith(".dart")) return true;
  return (
    f.endsWith(".dart") &&
    !f.startsWith("dart:") &&
    !f.includes("package:flutter")
  );
}

/**
 * 是否为业务 App 的 lib/ 源码。
 * @param packageName 可选：pubspec name，用于识别 package:<name>/...
 */
export function isAppLibFile(file: string, packageName?: string): boolean {
  const f = file.toLowerCase().replace(/^file:\/\//, "");
  if (!f || isFrameworkOrSdkFile(f)) return false;
  if (f.startsWith("lib/")) return true;
  if (packageName) {
    const prefix = `package:${packageName.toLowerCase()}/`;
    if (f.startsWith(prefix)) return true;
  }
  // 已归一化为 lib/... 的 package URI
  return false;
}

/** 从 pubspec.yaml 文本解析 name */
export function parsePubspecPackageName(pubspecText: string): string | undefined {
  const m = pubspecText.match(/^\s*name:\s*['"]?([A-Za-z0-9_]+)['"]?\s*$/m);
  return m?.[1];
}
