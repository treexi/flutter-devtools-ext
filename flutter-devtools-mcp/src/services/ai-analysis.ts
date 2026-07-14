import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  HOT_FUNCTION_ABNORMAL_MS,
  type PerformanceSessionResult,
} from "./session-types.js";
import {
  formatNetworkPathStat,
  isDioJsonDecodeIsolate,
  enrichPerformanceSession,
} from "./network-aggregate.js";
import {
  enrichRebuildsWithBusiness,
  formatRebuildLocationCell,
  type RebuildEntry,
} from "./rebuild-business-resolver.js";
import {
  formatBytesKb as formatParseBytesKb,
  parseSourceLabel,
  type ParsePathStat,
} from "./json-parse-aggregate.js";
import type { ThresholdAlerts } from "./threshold-alerts.js";

export interface AiAnalysisOptions {
  projectRoot?: string;
}

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_FLUTTER_SIMPLE = join(MCP_ROOT, "..", "flutter-simple");

interface Finding {
  priority: "P0" | "P1" | "P2";
  title: string;
  evidence: string;
  cause: string;
  fix: string;
}

const REBUILD_ABNORMAL_COUNT = 100;

function isMemoryCollected(result: PerformanceSessionResult): boolean {
  if (result.memory.collected === false) return false;
  if (result.memory.collected === true) return true;
  return result.memory.heapMb > 0 || result.memory.utilizationPct > 0;
}
const REBUILD_ATTENTION_COUNT = 30;
/** 摘要只展示重建 Top3 */
const REBUILD_SUMMARY_TOP_N = 3;

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mdTable(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_（无数据）_"];
  return [
    `| ${headers.map(mdEscapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) => `| ${row.map((c) => mdEscapeCell(String(c))).join(" | ")} |`
    ),
  ];
}

function formatBytesKb(bytes?: number): string {
  if (bytes == null || bytes <= 0) return "-";
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
  }
  return `${Math.round((bytes / 1024) * 10) / 10}KB`;
}

function formatRuntimeSummaryTable(
  rows: Array<{
    dim: string;
    verdict: "正常" | "注意" | "异常" | "无数据";
    data: string;
    action: string;
  }>
): string[] {
  const tag = (v: "正常" | "注意" | "异常" | "无数据") =>
    v === "异常"
      ? "🔴异常"
      : v === "注意"
        ? "🟡注意"
        : v === "无数据"
          ? "⚪无数据"
          : "🟢正常";
  return [
    ...mdTable(
      ["维度", "状态", "数据", "详情"],
      rows.map((r) => [r.dim, tag(r.verdict), r.data, r.action || "-"])
    ),
    "",
  ];
}

function formatRebuildTable(
  items: PerformanceSessionResult["topRebuilds"],
  projectRoot?: string
): string[] {
  if (items.length === 0) {
    return ["_无 rebuild 数据（profile 模式常见）_", ""];
  }
  const rows = items.slice(0, REBUILD_SUMMARY_TOP_N).map((r) => {
    const { biz, component } = formatRebuildLocationCell(r, projectRoot);
    return [r.widget, String(r.count), biz, component];
  });
  return [
    ...mdTable(["Widget", "次数", "业务定位", "组件位置"], rows),
    "",
  ];
}

function formatLargeImageUrl(
  item: ThresholdAlerts["largeImages"][number]
): string {
  if (item.url?.startsWith("http")) return item.url;
  return item.path || item.url || "-";
}

function formatLargeImageTable(
  alerts: ThresholdAlerts,
  heading = "#### 大图片（体积 / 解码超阈）"
): string[] {
  if (alerts.largeImages.length === 0) {
    return [];
  }
  const rows = alerts.largeImages.map((i) => [
    formatLargeImageUrl(i),
    formatParseBytesKb(i.bytes),
    i.decodeMs != null ? `${i.decodeMs}ms` : "-",
    i.httpMs != null ? `${i.httpMs}ms` : "-",
    i.width && i.height ? `${i.width}x${i.height}` : "-",
    i.triggers.join("; "),
    i.source,
  ]);
  return [
    heading,
    ...mdTable(
      ["Path / URL", "体积", "解码", "HTTP", "尺寸", "命中", "来源"],
      rows
    ),
    "",
  ];
}

function formatLargeApiTable(
  alerts: ThresholdAlerts,
  heading = "#### 大接口（体积 / 解析超阈）"
): string[] {
  if (alerts.largeApis.length === 0) {
    return [];
  }
  const rows = alerts.largeApis.map((a) => [
    a.method ?? "-",
    a.path,
    String(a.count),
    formatParseBytesKb(a.avgBytes ?? a.bytes),
    `${a.avgParseMs}ms`,
    `${a.totalParseMs}ms`,
    a.triggers.join("; "),
    a.parseSource ? parseSourceLabel(a.parseSource) : "-",
  ]);
  return [
    heading,
    "_解析含 HttpProfile 后置段 + Dio Worker 分摊_",
    ...mdTable(
      ["Method", "Path", "次数", "Avg体积", "Avg解析", "合计解析", "命中", "来源"],
      rows
    ),
    "",
  ];
}

function formatHotFunctionsTable(
  funcs: PerformanceSessionResult["projectTopFunctions"]
): string[] {
  if (funcs.length === 0) {
    return ["_未命中业务 lib/ 方法_", ""];
  }
  const rows = funcs.slice(0, 10).map((f) => [
    f.name,
    f.file,
    `${f.selfMs}ms`,
    `${f.pct}%`,
    f.selfMs > HOT_FUNCTION_ABNORMAL_MS ? "🔴" : "",
  ]);
  return [
    ...mdTable(["函数", "文件", "Self", "占比", "标记"], rows),
    "",
  ];
}

function dioSuggestionsForTableView(suggestions: string[]): string[] {
  return suggestions.filter(
    (s) =>
      !s.startsWith("采集窗口内高频/大响应接口") &&
      !s.startsWith("已统计到 HTTP 次数但未解析") &&
      !s.startsWith("接口明细见报告")
  );
}

function selectRebuildsForSummary(
  topRebuilds: PerformanceSessionResult["topRebuilds"]
): PerformanceSessionResult["topRebuilds"] {
  return topRebuilds.slice(0, REBUILD_SUMMARY_TOP_N);
}

function detectCodeFindings(source: string): Finding[] {
  const findings: Finding[] = [];

  if (/Timer\.periodic/.test(source) && /setState/.test(source)) {
    findings.push({
      priority: "P0",
      title: "高频全局 setState 导致整树重建",
      evidence: "Timer.periodic + setState 同文件出现",
      cause: "父组件周期性 setState，子树随 tick 被动重建。",
      fix:
        "移除全局 tick 刷新；改为 ValueNotifier/Stream 仅更新必要子树，或对列表项使用 const + 独立状态。",
    });
  }

  if (/class OrderCard/.test(source) && /required this\.tick/.test(source)) {
    findings.push({
      priority: "P0",
      title: "OrderCard 依赖父级 tick 导致被动重建",
      evidence: "OrderCard 构造函数含 tick 参数",
      cause: "子组件 build 签名依赖父 setState 变量，无法局部隔离重建。",
      fix:
        "将 tick 相关展示拆到独立 StatefulWidget，或用 ListenableBuilder 缩小重建范围。",
    });
  }

  if (/for\s*\([^)]*<\s*200/.test(source) && /Widget build/.test(source)) {
    findings.push({
      priority: "P1",
      title: "build 方法内同步循环计算",
      evidence: "build 内 for 循环 checksum 计算",
      cause: "每次重建都在 UI 线程做 O(n) 计算，放大 jank。",
      fix: "将 checksum 移到 initState/compute 或缓存到 FeedItem 模型。",
    });
  }

  if (/HttpClient/.test(source) && /setState/.test(source)) {
    findings.push({
      priority: "P1",
      title: "网络回调触发额外 setState",
      evidence: "HttpClient 与 setState 同文件",
      cause: "请求开始/结束各触发 setState，叠加高频 tick 重建。",
      fix: "用 Riverpod/Bloc 管理网络状态；请求进行中避免整页刷新。",
    });
  }

  if (/ListView\.builder/.test(source) && !/itemExtent|cacheExtent/.test(source)) {
    findings.push({
      priority: "P2",
      title: "长列表未做重建隔离优化",
      evidence: "ListView.builder 无 itemExtent/cacheExtent",
      cause: "频繁父级重建时列表项无法有效复用。",
      fix: "为列表项添加 Key、const 子组件，或配合 AutomaticKeepAliveClientMixin。",
    });
  }

  return findings;
}

function rebuildFixHint(topRebuilds: PerformanceSessionResult["topRebuilds"]): string {
  const targets = selectRebuildsForSummary(topRebuilds);
  if (targets.length === 0) {
    return "缩小 setState/Animation 触发范围，见 P0 代码项。";
  }
  const locs = targets
    .map((r) => {
      if (r.bizFile && r.bizWidget) {
        const short = r.bizFile.split("/").slice(-2).join("/");
        return `${r.bizWidget}(${short}:${r.bizLine ?? r.line})`;
      }
      return `${r.file.split("/").pop()}:${r.line}`;
    })
    .join("、");
  return `按下方「重建」定位排查 ${locs} 的触发源，缩小 setState/Animation 范围。`;
}

function findingsFromRuntime(result: PerformanceSessionResult): Finding[] {
  const findings: Finding[] = [];
  const recSec = result.recordingWindowSec ?? result.durationSec;
  const maxRebuild = result.topRebuilds[0]?.count ?? 0;

  if (maxRebuild > 100) {
    const top = result.topRebuilds[0];
    findings.push({
      priority: "P0",
      title: "运行时检测到大量 Widget 重建",
      evidence: `最高 ${top?.widget ?? "Unknown"} ${maxRebuild}x / 录制 ${recSec}s`,
      cause: "高频 Animation/setState 或父级 tick 导致子树被动重建。",
      fix: rebuildFixHint(result.topRebuilds),
    });
  }

  const bizHot = result.projectTopFunctions[0];
  if (bizHot && bizHot.selfMs > HOT_FUNCTION_ABNORMAL_MS) {
    findings.push({
      priority: bizHot.selfMs >= 50 || result.frames.jankPct > 5 ? "P0" : "P1",
      title: "业务热点函数 Self 时间偏高",
      evidence: `Top ${bizHot.name} Self ${bizHot.selfMs}ms / 录制 ${recSec}s`,
      cause: "热路径在主 isolate 累计耗时过高，可能放大 rebuild/GC 影响。",
      fix: "移出 build/回调热路径，或缓存/下沉 isolate。",
    });
  }

  if (result.frames.jankPct > 5) {
    findings.push({
      priority: "P0",
      title: "掉帧率偏高",
      evidence: `掉帧 ${result.frames.jankPct}%（${result.frames.jankCount}/${result.frames.total}）`,
      cause: "主线程 build/布局压力过大。",
      fix: "减少重建范围 + 移出 build 内计算 + profile 模式验证。",
    });
  }

  const worstScroll = result.scrollFps?.worstSegments?.[0];
  if (worstScroll && worstScroll.jankPct > 15 && worstScroll.frames >= 5) {
    findings.push({
      priority: "P0",
      title: "滚动段掉帧明显",
      evidence: `${worstScroll.startSec}-${worstScroll.endSec}s: ${worstScroll.fps} FPS, jank ${worstScroll.jankPct}%`,
      cause: "列表滚动期间主线程过载（重建/布局/解码）。",
      fix: "缩小重建范围、itemExtent、预解码图片、避免滚动中同步计算。",
    });
  }

  if (
    result.gc &&
    (result.gc.longPauseCount >= 3 || result.gc.maxPauseMs > 32)
  ) {
    findings.push({
      priority: "P1",
      title: "GC 停顿可能造成卡顿尖刺",
      evidence: `GC ${result.gc.count} 次, 最长 ${result.gc.maxPauseMs}ms, >8ms ${result.gc.longPauseCount} 次`,
      cause: "短生命周期对象分配过多触发频繁/长 GC。",
      fix: "减少每帧临时 List/String/闭包；复用对象；大计算移出 UI isolate。",
    });
  }

  if (result.imageDecode && result.imageDecode.maxMs > 32) {
    const top = result.imageDecode.slow[0];
    const where = top?.url
      ? `，图: ${top.url}`
      : top
        ? `，事件: ${top.name}`
        : "";
    findings.push({
      priority: "P1",
      title: "图片解码偏慢",
      evidence: `解码 ${result.imageDecode.count} 次, 最长 ${result.imageDecode.maxMs}ms, 合计 ${result.imageDecode.totalMs}ms${where}`,
      cause: "大图在 UI 路径同步解码或缺少缓存。",
      fix: top?.url
        ? `针对 ${top.url}：缩小分辨率、ResizeImage/预缓存，或 cached_network_image。`
        : "缩小分辨率、预缓存、使用 cached_network_image / ResizeImage。",
    });
  }

  const dio = result.dioJsonDecode;
  const bgBusy = (result.isolateCpu ?? []).filter(
    (i) => !i.isMain && i.topSelfMs > 100 && !isDioJsonDecodeIsolate(i.name)
  );
  if (dio) {
    findings.push({
      priority: "P2",
      title: "Dio 后台 JSON 解析占用 CPU",
      evidence:
        `${dio.workerCount} 个 FusedTransformer worker, 累计 ~${dio.totalWorkerCpuMs}ms; ` +
        `HTTP ${dio.networkTotal} 次 (${dio.networkQps} req/s), ≥${dio.isolateThresholdKb}KB 响应 ${dio.largeJsonResponseCount} 次，` +
        `明细见「大接口」表`,
      cause:
        "Dio 5.9 默认对 ≥50KB JSON 在后台 isolate 做 utf8+json 解析，高并发或大 payload 会增加 CPU/GC 压力。",
      fix:
        dio.topPaths.length > 0
          ? "见「大接口」表：优先排查超阈 path 的 payload 体积、缓存/去重与是否可 sync 解析。"
          : (dio.suggestions.find((s) => !s.startsWith("采集窗口内高频")) ??
            "检查高频接口缓存与 payload 体积。"),
    });
  } else if (bgBusy.length > 0) {
    findings.push({
      priority: "P2",
      title: "后台 isolate 有明显 CPU",
      evidence: bgBusy
        .map((i) => `${i.name}: ${i.topName} ${i.topSelfMs}ms`)
        .join("; "),
      cause: "后台任务占用 CPU，可能与主 isolate 争抢。",
      fix: "确认后台任务优先级；避免与 UI 高峰重叠。",
    });
  } else if (
    (result.isolateCpu ?? []).filter((i) => i.isMain).length === 1 &&
    (result.isolateCpu ?? []).every((i) => i.isMain) &&
    (result.projectTopFunctions[0]?.selfMs ?? 0) > 200
  ) {
    findings.push({
      priority: "P2",
      title: "重计算仍在主 isolate",
      evidence: `业务热点 ${result.projectTopFunctions[0]?.name} ${result.projectTopFunctions[0]?.selfMs}ms，未见后台 isolate 分担`,
      cause: "热路径同步计算阻塞 UI。",
      fix: "将纯计算用 compute()/Isolate.run 下沉。",
    });
  }

  if (isMemoryCollected(result) && result.memory.utilizationPct > 85) {
    findings.push({
      priority: "P1",
      title: "堆内存利用率偏高",
      evidence: `Heap ${result.memory.heapMb}MB, 利用率 ${result.memory.utilizationPct}%`,
      cause: "debug 模式堆偏大；频繁重建产生短生命周期对象。",
      fix: "修复重建后复测；发布前用 profile/release 对比内存。",
    });
  }

  if (result.network.total > 0 && result.network.errors > 0) {
    findings.push({
      priority: "P1",
      title: "网络请求存在失败",
      evidence: `${result.network.errors}/${result.network.total} 失败`,
      cause: "HttpClient 未复用或网络权限/证书问题。",
      fix: "使用单例 HttpClient + 错误重试；检查 Android INTERNET 权限。",
    });
  }

  const ta = result.thresholdAlerts;
  if (ta && (ta.summary.largeImageHits > 0 || ta.summary.slowDecodeHits > 0)) {
    findings.push({
      priority: ta.summary.slowDecodeHits > 0 ? "P1" : "P2",
      title: "大图片或慢解码超阈值",
      evidence: `大图 ${ta.summary.largeImageHits}, 慢解码 ${ta.summary.slowDecodeHits}（阈值 ${Math.round(ta.config.largeImageBytes / 1024)}KB / ${ta.config.slowImageDecodeMs}ms）`,
      cause: "大图同步解码或慢 HTTP 下载阻塞 UI/GC。",
      fix: "缩小分辨率、ResizeImage/预缓存、cached_network_image。",
    });
  }
  if (ta && (ta.summary.largeApiHits > 0 || ta.summary.slowParseHits > 0)) {
    findings.push({
      priority: ta.summary.slowParseHits > 0 ? "P1" : "P2",
      title: "大接口或 JSON 解析超阈值",
      evidence: `大接口 ${ta.summary.largeApiHits}, 慢解析 ${ta.summary.slowParseHits}（阈值 ${Math.round(ta.config.largeApiBytes / 1024)}KB / ${ta.config.slowApiParseMs}ms）`,
      cause: "大 payload 或高频 JSON 解析增加 CPU/GC 压力。",
      fix: "缩小 payload、缓存/去重、提高 contentLengthIsolateThreshold 或 sync 小响应。",
    });
  }

  return findings;
}

function mergeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.priority}:${f.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  const order = { P0: 0, P1: 1, P2: 2 };
  return out.sort((a, b) => order[a.priority] - order[b.priority]);
}

async function readProjectSources(
  result: PerformanceSessionResult,
  projectRoot: string
): Promise<string> {
  const paths = new Set<string>(result.filesToInspect);
  paths.add("lib/main.dart");

  const chunks: string[] = [];
  for (const rel of paths) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    try {
      const content = await readFile(full, "utf-8");
      chunks.push(`// ${rel}\n${content}`);
    } catch {
      // skip
    }
  }
  return chunks.join("\n\n");
}

export async function generateAiAnalysis(
  result: PerformanceSessionResult,
  options: AiAnalysisOptions = {}
): Promise<string> {
  const projectRoot = options.projectRoot ?? DEFAULT_FLUTTER_SIMPLE;
  result = enrichPerformanceSession(result, { projectRoot: options.projectRoot });

  const source = await readProjectSources(result, projectRoot);
  const findings = mergeFindings([
    ...findingsFromRuntime(result),
    ...detectCodeFindings(source),
  ]);

  const byPriority = {
    P0: findings.filter((f) => f.priority === "P0"),
    P1: findings.filter((f) => f.priority === "P1"),
    P2: findings.filter((f) => f.priority === "P2"),
  };

  const bizTop = result.projectTopFunctions
    .slice(0, 3)
    .map((f) => `${f.name} ${f.selfMs}ms`)
    .join(", ");
  const recSec = result.recordingWindowSec ?? result.durationSec;
  const wallSec = result.wallClockSec ?? result.durationSec;
  const parseTop = result.network.topParsePaths?.[0];
  const dio = result.dioJsonDecode;
  const dioWorkerMs = dio?.totalWorkerCpuMs ?? 0;
  const thresholdAlerts = result.thresholdAlerts;

  type Verdict = "正常" | "注意" | "异常" | "无数据";

  const frameVerdict: Verdict =
    result.frames.total < 10
      ? "无数据"
      : result.frames.jankPct > 15
        ? "异常"
        : result.frames.jankPct > 5
          ? "注意"
          : "正常";
  const frameData = `${result.frames.total} 帧, P99 ${result.frames.p99Ms}ms, jank ${result.frames.jankPct}%; B/L/P max ${result.frames.buildMaxMs}/${result.frames.layoutMaxMs}/${result.frames.paintMaxMs}ms`;
  const frameAction =
    frameVerdict === "无数据"
      ? "Timeline 帧偏少，以耗时函数/图片解码为准"
      : frameVerdict !== "正常"
        ? "见下方「帧」"
        : "-";

  const rebuildItems = selectRebuildsForSummary(result.topRebuilds);
  const rebuildTop = rebuildItems[0];
  const rebuildVerdict: Verdict = !rebuildTop
    ? "无数据"
    : rebuildTop.count > REBUILD_ABNORMAL_COUNT
      ? "异常"
      : rebuildTop.count > REBUILD_ATTENTION_COUNT
        ? "注意"
        : "正常";
  const rebuildData = !rebuildTop
    ? "profile 下常无 rebuild 数据"
    : `Top${REBUILD_SUMMARY_TOP_N}，最高 ${rebuildTop.widget} ${rebuildTop.count}x`;
  const rebuildAction = !rebuildTop
    ? "需要时用 debug 补采"
    : rebuildVerdict !== "正常"
      ? "见下方「重建」"
      : "-";

  const bizHot = result.projectTopFunctions[0];
  const bizVerdict: Verdict = !bizHot
    ? "无数据"
    : bizHot.selfMs > HOT_FUNCTION_ABNORMAL_MS
      ? "异常"
      : "正常";
  const bizData = bizHot
    ? `${bizTop || bizHot.name} @ ${bizHot.file}`
    : "未命中业务 lib/ 方法";
  const bizAction = !bizHot
    ? "延长采集并持续操作页面"
    : bizVerdict !== "正常"
      ? "见下方「耗时函数」"
      : "-";

  const worstScroll = result.scrollFps?.worstSegments?.[0];
  const scrollVerdict: Verdict = !worstScroll
    ? "无数据"
    : worstScroll.jankPct > 15
      ? "异常"
      : worstScroll.jankPct > 5 || (result.scrollFps?.overallFps ?? 60) < 50
        ? "注意"
        : "正常";
  const scrollData = worstScroll
    ? `~${result.scrollFps!.overallFps} FPS, 段 ${worstScroll.startSec}-${worstScroll.endSec}s, jank ${worstScroll.jankPct}%`
    : "无足够帧分段";
  const scrollAction =
    scrollVerdict !== "正常" && scrollVerdict !== "无数据"
      ? "见下方「滚动」"
      : "-";

  const img = result.imageDecode;
  const imgThresholdHits =
    (thresholdAlerts?.summary.largeImageHits ?? 0) +
    (thresholdAlerts?.summary.slowDecodeHits ?? 0);
  let imgVerdict: Verdict =
    thresholdAlerts && imgThresholdHits > 0
      ? (thresholdAlerts.summary.slowDecodeHits ?? 0) > 0
        ? "异常"
        : "注意"
      : !img || (img.count === 0 && !(img.untimedSignals && img.untimedSignals > 0))
        ? "正常"
        : img.count === 0 && (img.untimedSignals ?? 0) > 0
          ? "无数据"
          : img.maxMs > 100
            ? "异常"
            : img.maxMs > 32
              ? "注意"
              : "正常";
  let imgData =
    thresholdAlerts && imgThresholdHits > 0
      ? `大图 ${thresholdAlerts.summary.largeImageHits}, 慢解码 ${thresholdAlerts.summary.slowDecodeHits}`
      : img && img.count > 0
        ? `${img.count} 次, 最长 ${img.maxMs}ms` +
          (img.slow[0]?.url
            ? ` (${img.slow[0].url.length > 40 ? `${img.slow[0].url.slice(0, 37)}...` : img.slow[0].url})`
            : "")
        : img && (img.untimedSignals ?? 0) > 0
          ? `${img.untimedSignals} 次信号无时长`
          : "未检测到解码事件";
  let imgAction =
    thresholdAlerts && imgThresholdHits > 0
      ? "见下方「图片解码」"
      : imgVerdict === "无数据"
        ? "确认埋点写入 args.ms"
        : imgVerdict !== "正常"
          ? "见下方「图片解码」"
          : "-";

  const isoBg = (result.isolateCpu ?? []).filter((i) => !i.isMain);
  const isoVerdict: Verdict = dio
    ? dio.workerCount >= 4 || dio.totalWorkerCpuMs > 2000
      ? "注意"
      : "正常"
    : isoBg.some((i) => i.topSelfMs > 100)
      ? "注意"
      : (bizHot?.selfMs ?? 0) > 100 &&
          isoBg.every((i) => i.topSelfMs < 50 || isDioJsonDecodeIsolate(i.name))
        ? "注意"
        : "正常";
  const isoData = dio
    ? `Dio worker ${dio.workerCount} 个, CPU ~${dio.totalWorkerCpuMs}ms`
    : isoBg.length > 0
      ? `主+后台 ${isoBg.length} 个` +
        (isoBg[0] ? `, 后台 ${isoBg[0].topSelfMs}ms` : "")
      : "仅主 isolate";
  const isoAction = dio
    ? "见下方「Isolate」"
    : isoVerdict === "注意"
      ? "见下方「Isolate」"
      : "-";

  const apiThresholdHits =
    (thresholdAlerts?.summary.largeApiHits ?? 0) +
    (thresholdAlerts?.summary.slowParseHits ?? 0);
  const netVerdict: Verdict =
    result.network.errors > 0
      ? "异常"
      : apiThresholdHits > 0
        ? "注意"
        : dio && dio.networkQps >= 2
          ? "注意"
          : "正常";
  const netParts: string[] = [`${result.network.total} 请求`];
  if (result.network.errors) netParts.push(`${result.network.errors} 失败`);
  if (dioWorkerMs > 0) netParts.push(`JSON 解析 CPU ~${dioWorkerMs}ms`);
  if (thresholdAlerts && apiThresholdHits > 0) {
    netParts.push(
      `超阈 大接口 ${thresholdAlerts.summary.largeApiHits} / 慢解析 ${thresholdAlerts.summary.slowParseHits}`
    );
  } else if (parseTop) {
    netParts.push(`解析 Top ${parseTop.path} 合计 ${parseTop.totalParseMs}ms`);
  }
  if (result.network.qps != null && result.network.total > 0) {
    netParts.push(`${result.network.qps} req/s`);
  }
  const netData = netParts.join(", ");
  const netAction =
    thresholdAlerts && apiThresholdHits > 0
      ? "见下方「网络」"
      : netVerdict !== "正常"
        ? "见下方「网络」"
        : "-";

  const memVerdict: Verdict = !isMemoryCollected(result)
    ? "无数据"
    : result.memory.utilizationPct > 90
      ? "异常"
      : result.memory.utilizationPct > 80
        ? "注意"
        : "正常";
  const memData = isMemoryCollected(result)
    ? `${result.memory.heapMb}MB (${result.memory.utilizationPct}%)`
    : "默认关闭 enableMemory";
  const memAction = isMemoryCollected(result)
    ? memVerdict !== "正常"
      ? "见下方「内存」"
      : "-"
    : "需时用 get_memory_snapshot";

  const gcVerdict: Verdict = !result.gc
    ? "无数据"
    : result.gc.maxPauseMs > 80 || result.gc.longPauseCount >= 10
      ? "异常"
      : result.gc.longPauseCount >= 3 || result.gc.maxPauseMs > 32
        ? "注意"
        : "正常";
  const gcData = result.gc
    ? `${result.gc.count} 次, 最长 ${result.gc.maxPauseMs}ms, >8ms ${result.gc.longPauseCount} 次`
    : "未采集";
  const gcAction =
    gcVerdict !== "正常" && gcVerdict !== "无数据" ? "见下方「GC」" : "-";

  const runtimeSummaryRows: Array<{
    dim: string;
    verdict: Verdict;
    data: string;
    action: string;
  }> = [
    { dim: "帧", verdict: frameVerdict, data: frameData, action: frameAction },
    { dim: "重建", verdict: rebuildVerdict, data: rebuildData, action: rebuildAction },
    { dim: "耗时函数", verdict: bizVerdict, data: bizData, action: bizAction },
    { dim: "滚动", verdict: scrollVerdict, data: scrollData, action: scrollAction },
    { dim: "图片解码", verdict: imgVerdict, data: imgData, action: imgAction },
    { dim: "GC", verdict: gcVerdict, data: gcData, action: gcAction },
    { dim: "Isolate", verdict: isoVerdict, data: isoData, action: isoAction },
    { dim: "网络", verdict: netVerdict, data: netData, action: netAction },
    { dim: "内存", verdict: memVerdict, data: memData, action: memAction },
  ];

  const lines = [
    `# 性能优化方案（规则引擎 + 源码对照）`,
    ``,
    `**场景**: ${result.scenario}  |  **录制**: ${recSec}s  |  **总耗时**: ${wallSec}s  |  **掉帧**: ${result.frames.jankPct}%`,
    ``,
    `## 运行时摘要`,
    ...formatRuntimeSummaryTable(runtimeSummaryRows),
    `## 维度详情`,
    ``,
    `### 帧`,
    `- ${frameData}`,
    `- 平均 ${result.frames.avgMs}ms · jank ${result.frames.jankCount}/${result.frames.total}`,
    ``,
    `### 重建`,
    ...formatRebuildTable(rebuildItems, projectRoot),
    `### 耗时函数`,
    ...formatHotFunctionsTable(result.projectTopFunctions),
    `### 滚动`,
  ];

  if (result.scrollFps?.worstSegments?.length) {
    const scrollRows = result.scrollFps.worstSegments.map((s) => [
      `${s.startSec}-${s.endSec}s`,
      `${s.fps}`,
      `${s.jankPct}%`,
      `${s.jankCount}/${s.frames}`,
      `${s.maxMs}ms`,
    ]);
    lines.push(
      `- 段内整体 ~${result.scrollFps.overallFps} FPS`,
      ...mdTable(["时段", "FPS", "Jank", "帧", "Max"], scrollRows),
      ``
    );
  } else {
    lines.push(`- _无足够帧分段_`, ``);
  }

  lines.push(`### 图片解码`);
  lines.push(`- ${imgData}`);
  if (result.imageDecode && result.imageDecode.count > 0) {
    lines.push(
      `- 合计 ${result.imageDecode.totalMs}ms · 最长 ${result.imageDecode.maxMs}ms`
    );
    for (const s of result.imageDecode.slow.slice(0, 5)) {
      const parts = [`${s.name} ${s.ms}ms`];
      if (s.url) parts.push(s.url);
      if (s.width && s.height) parts.push(`${s.width}x${s.height}`);
      if (s.bytes && s.bytes > 0) parts.push(formatBytesKb(s.bytes));
      lines.push(`- 慢解码: ${parts.join(" | ")}`);
    }
  }
  if (thresholdAlerts) {
    lines.push(...formatLargeImageTable(thresholdAlerts));
  }
  lines.push(``);

  lines.push(`### GC`);
  if (result.gc) {
    lines.push(
      `- ${result.gc.count} 次 · 总停顿 ${result.gc.totalPauseMs}ms · 最长 ${result.gc.maxPauseMs}ms · >8ms ${result.gc.longPauseCount} 次`
    );
    if (result.gc.topPauses?.length) {
      lines.push(
        `- Top 停顿: ${result.gc.topPauses
          .slice(0, 5)
          .map((p) => `${p.name} ${p.ms}ms`)
          .join(", ")}`
      );
    }
  } else {
    lines.push(`- _未采集_`);
  }
  lines.push(``);

  lines.push(`### Isolate`);
  const mainIso = result.isolateCpu?.find((i) => i.isMain);
  if (dio) {
    lines.push(
      `- Dio FusedTransformer: ${dio.workerCount} worker · CPU ~${dio.totalWorkerCpuMs}ms · ≥${dio.isolateThresholdKb}KB 响应 ${dio.largeJsonResponseCount} 次`
    );
    lines.push(
      `- 关联 HTTP: ${dio.networkTotal} 次 · ${dio.networkQps} req/s`
    );
    const sug = dioSuggestionsForTableView(dio.suggestions);
    for (const s of sug) lines.push(`- ${s}`);
  }
  if (result.isolateCpu && result.isolateCpu.length > 0) {
    const isoRows = result.isolateCpu.map((i) => {
      const topLabel = /drawframe|handledrawframe|invokeframe|persistentframe/i.test(
        i.topName
      )
        ? `刷帧链路(${i.topName})`
        : `${i.topName} ${i.topSelfMs}ms`;
      return [
        i.isMain ? "主" : "后台",
        i.name.length > 48 ? `${i.name.slice(0, 45)}...` : i.name,
        String(i.sampleCount),
        topLabel,
      ];
    });
    lines.push(...mdTable(["类型", "Isolate", "Samples", "Top"], isoRows), ``);
  } else if (!dio) {
    lines.push(`- _未采样_`, ``);
  } else if (mainIso) {
    lines.push(
      `- 主 isolate: samples=${mainIso.sampleCount}, top=${mainIso.topName} ${mainIso.topSelfMs}ms`,
      ``
    );
  }

  lines.push(`### 网络`);
  lines.push(`- ${netData}`);
  if (result.network.topPaths && result.network.topPaths.length > 0) {
    const netRows = result.network.topPaths.slice(0, 10).map((p) => [
      p.method ?? "-",
      p.path,
      String(p.count),
      p.avgMs != null ? `${p.avgMs}ms` : "-",
      p.totalBytes != null && p.totalBytes > 0
        ? formatBytesKb(p.totalBytes)
        : "-",
    ]);
    lines.push(
      `- Top 接口`,
      ...mdTable(["Method", "Path", "次数", "Avg", "体积"], netRows),
      ``
    );
  }
  if (parseTop) {
    lines.push(
      `- 解析 Top: ${parseTop.path} 合计 ${parseTop.totalParseMs}ms (${parseSourceLabel(parseTop.source)})`
    );
  }
  if (thresholdAlerts) {
    lines.push(...formatLargeApiTable(thresholdAlerts));
  }
  if (!result.network.topPaths?.length && !thresholdAlerts?.largeApis.length) {
    lines.push(``);
  }

  lines.push(`### 内存`);
  if (isMemoryCollected(result)) {
    lines.push(
      `- Heap ${result.memory.heapMb}MB · 利用率 ${result.memory.utilizationPct}%`
    );
    if (result.memory.topClasses?.length) {
      lines.push(
        `- Top 类: ${result.memory.topClasses
          .slice(0, 5)
          .map((c) => `${c.name} ${c.bytesMb}MB`)
          .join(", ")}`
      );
    }
  } else {
    lines.push(`- ${memData}`);
  }
  lines.push(``);

  for (const priority of ["P0", "P1", "P2"] as const) {
    const items = byPriority[priority];
    lines.push(
      `## ${priority}${priority === "P0" ? "（必须修复）" : priority === "P1" ? "（建议修复）" : "（可选优化）"}`
    );
    if (items.length === 0) {
      lines.push(`- 无`, ``);
    } else {
      for (const item of items) {
        lines.push(
          `### ${item.title}`,
          `- **数据**: ${item.evidence}`,
          `- **原因**: ${item.cause}`,
          `- **改法**: ${item.fix}`,
          ``
        );
      }
    }
  }

  lines.push("---", "*由 flutter-devtools-mcp 规则引擎生成，非 LLM 调用。*");

  return lines.join("\n");
}
