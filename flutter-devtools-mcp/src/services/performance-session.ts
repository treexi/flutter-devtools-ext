import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { FlutterVmServiceClient } from "./vm-service-client.js";
import { Profiler } from "./profiler.js";
import { RebuildTrackerService } from "./rebuild-tracker-service.js";
import { NetworkCaptureService } from "./network-capture-service.js";
import { CpuProfilerService } from "./cpu-profiler-service.js";
import {
  isAppLibFile,
  isFrameworkOrSdkFile,
  isProjectSourceFile,
  parsePubspecPackageName,
  type PerformanceSessionResult,
  resolveSessionOutputDir,
  JANK_TARGET_FPS,
} from "./session-types.js";
import {
  parseDartTimelineCpu,
  parseProfilerHotspots,
  parsePhaseCpuFallback,
} from "./timeline-cpu-parser.js";
import {
  parseGcStats,
  parseImageDecodeStats,
  parseScrollFpsSegments,
  pickWorstScrollSegments,
  formatSlowImageDecodeLine,
} from "./timeline-extras.js";
import { generateAiAnalysis } from "./ai-analysis.js";
import {
  aggregateNetworkRequests,
  buildDioJsonDecodeInsight,
} from "./network-aggregate.js";
import { enrichRebuildsWithBusiness, type RebuildEntry } from "./rebuild-business-resolver.js";
import { aggregateParseCostByPath } from "./json-parse-aggregate.js";
import {
  buildThresholdAlerts,
  deriveThresholdAlertsFromLegacy,
} from "./threshold-alerts.js";
import {
  DEFAULT_PROGRESS,
  formatCollectEta,
  sleepWithProgress,
  type CollectProgressFn,
} from "./collect-progress.js";
import {
  isBusinessCpuSymbol,
  isVmInternalCpuSymbol,
  humanizeVmCpuSymbol,
  isMisattributedVmCpuEntry,
  sanitizeSessionCpuTops,
} from "./cpu-symbol-filter.js";

const VM_INTERNAL_CLASSES = new Set([
  "_OneByteString",
  "_TwoByteString",
  "String",
  "_List",
  "_GrowableList",
  "_Mint",
  "_Uint8List",
  "StreamSubscription",
]);

function isVmInternal(name: string): boolean {
  return (
    VM_INTERNAL_CLASSES.has(name) ||
    (name.startsWith("_") &&
      name.length < 20 &&
      !name.includes("State") &&
      !name.includes("Controller"))
  );
}

export interface CollectSessionOptions {
  scenario?: string;
  durationSec?: number;
  warmupSec?: number;
  enableNetwork?: boolean;
  enableCpuProfile?: boolean;
  /** 是否拉取 getAllocationProfile(gc:true)；默认 false（Android debug 大堆极慢） */
  enableMemory?: boolean;
  topN?: number;
  saveToFile?: boolean;
  outputDir?: string;
  generateAiReport?: boolean;
  projectRoot?: string;
  /** 采集过程进度（默认 stderr 输出 [perf]） */
  onProgress?: CollectProgressFn;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKnownBusinessSymbol(name?: string): boolean {
  const n = name ?? "";
  return (
    n.includes("businessHotMethod") ||
    n.includes("OrderCard") ||
    n.includes("HomePage") ||
    n.includes("_HomePageState") ||
    n.includes("_OrderCard") ||
    n.includes("FeedItem")
  );
}

function isBusinessCpuEntry(
  entry: { name?: string; file: string; sourceUrl?: string },
  opts?: { projectRoot?: string; packageName?: string }
): boolean {
  if (!isBusinessCpuSymbol(entry.name, entry.file)) return false;

  const packageName = opts?.packageName;
  const projectRoot = opts?.projectRoot;
  const url = entry.sourceUrl ?? "";
  const file = entry.file ?? "";

  if (isFrameworkOrSdkFile(file) || isFrameworkOrSdkFile(url)) return false;
  if (isKnownBusinessSymbol(entry.name)) return true;

  // 强信号：package:<app>/ 或工程绝对路径
  if (packageName) {
    const pkgPrefix = `package:${packageName.toLowerCase()}/`;
    if (url.toLowerCase().includes(pkgPrefix) || file.toLowerCase().includes(pkgPrefix)) {
      return true;
    }
  }
  if (url.startsWith("file://") && projectRoot) {
    const sourcePath = url.replace(/^file:\/\//, "");
    const root = projectRoot.replace(/\/$/, "");
    if (sourcePath.startsWith(root + "/lib/")) return true;
    if (
      sourcePath.includes("/flutter/") ||
      sourcePath.includes("/.pub-cache/") ||
      sourcePath.includes("/dart-sdk/")
    ) {
      return false;
    }
  }

  // 归一化后的业务相对路径：仅接受「看起来像 App 源码」的 lib/ 文件
  // 排除 lib/ui、lib/src/widgets 等 SDK 形态
  if (isAppLibFile(file, packageName)) {
    const f = file.toLowerCase();
    if (f.startsWith("lib/") && !f.startsWith("lib/src/") && !f.startsWith("lib/ui/")) {
      return true;
    }
  }

  return false;
}

async function resolvePackageName(projectRoot?: string): Promise<string | undefined> {
  if (!projectRoot) return undefined;
  try {
    const text = await readFile(join(projectRoot, "pubspec.yaml"), "utf-8");
    return parsePubspecPackageName(text);
  } catch {
    return undefined;
  }
}

export class PerformanceSession {
  private client: FlutterVmServiceClient;
  private profiler: Profiler;
  private rebuildTracker: RebuildTrackerService;
  private networkCapture: NetworkCaptureService;
  private cpuProfiler: CpuProfilerService;
  private collecting = false;

  constructor(
    client: FlutterVmServiceClient,
    profiler: Profiler,
    rebuildTracker: RebuildTrackerService,
    networkCapture: NetworkCaptureService,
    cpuProfiler: CpuProfilerService
  ) {
    this.client = client;
    this.profiler = profiler;
    this.rebuildTracker = rebuildTracker;
    this.networkCapture = networkCapture;
    this.cpuProfiler = cpuProfiler;
  }

  get isCollecting(): boolean {
    return this.collecting;
  }

  async collect(options: CollectSessionOptions = {}): Promise<{
    result: PerformanceSessionResult;
    savedPath?: string;
  }> {
    if (!this.client.connected) {
      throw new Error("未连接 Flutter App，请先使用 discover_apps 或 connect");
    }

    if (this.collecting) {
      throw new Error("已有采集正在进行中");
    }

    if (this.profiler.isActive) {
      throw new Error("Profiler 已在运行，请先 stop_profiling");
    }

    const scenario = options.scenario ?? "manual-session";
    const durationSec = options.durationSec ?? 30;
    const warmupSec = options.warmupSec ?? 2;
    const enableNetwork = options.enableNetwork ?? true;
    const enableCpuProfile = options.enableCpuProfile ?? true;
    const enableMemory = options.enableMemory ?? false;
    const topN = options.topN ?? 15;
    const generateAiReport = options.generateAiReport ?? false;
    const onProgress = options.onProgress ?? DEFAULT_PROGRESS;
    const recordingWindowSec = warmupSec + durationSec;
    const progressLog: string[] = [];
    const say = (msg: string) => {
      onProgress(msg);
      progressLog.push(msg);
    };

    this.collecting = true;
    const startedAt = Date.now();
    let rebuildTrackingEnabled = false;
    const packageName = await resolvePackageName(options.projectRoot);
    if (packageName) {
      this.cpuProfiler.setPackageName(packageName);
    }

    say(formatCollectEta(recordingWindowSec, enableMemory));

    try {
      say("启动 Profiler / 重建追踪 / CPU / 网络…");
      await this.profiler.start();
      try {
        await this.rebuildTracker.start();
        rebuildTrackingEnabled = true;
      } catch {
        // profile 模式可能不支持 ext.flutter.inspector.trackRebuildDirtyWidgets
      }
      if (enableCpuProfile) await this.cpuProfiler.start();
      if (enableNetwork) await this.networkCapture.start();

      if (warmupSec > 0) {
        await sleepWithProgress(warmupSec, "预热", say, Math.min(5, warmupSec));
      }
      await sleepWithProgress(durationSec, "录制", say, 10);

      say("录制结束，正在拉取 Timeline…");
      const profiling = await this.profiler.stop();
      say(
        `Timeline 就绪（${profiling.traceEvents?.length ?? 0} 事件），统计重建…`
      );
      const rawRebuilds = rebuildTrackingEnabled
        ? await this.rebuildTracker.stop(topN)
        : [];
      let widgetTree: unknown;
      if (rebuildTrackingEnabled) {
        try {
          widgetTree = await this.client.getWidgetTree();
        } catch {
          // inspector 不可用时不做运行时上级追溯
        }
      }
      const rawRebuildsForBiz = rawRebuilds;

      let isolateCpu: PerformanceSessionResult["isolateCpu"] = [];
      if (enableCpuProfile && this.cpuProfiler.isActive) {
        try {
          say("采样各 isolate CPU（已限制数量，避免 Android 过慢）…");
          isolateCpu = await this.cpuProfiler.sampleAllIsolates(5);
          say(`isolate 采样完成（${isolateCpu.length} 个）`);
        } catch {
          isolateCpu = [];
        }
      }

      say("汇总 CPU Top 函数…");
      let topFunctions = enableCpuProfile
        ? await this.cpuProfiler.stop(topN)
        : [];
      let cpuProfileSource: PerformanceSessionResult["cpuProfileSource"] =
        topFunctions.length > 0 ? "vm-samples" : "none";

      if (topFunctions.length === 0 && enableCpuProfile) {
        const fromDart = parseDartTimelineCpu(
          profiling.traceEvents ?? [],
          topN
        );
        if (fromDart.length > 0) {
          topFunctions = fromDart.map(({ source: _, ...rest }) => rest);
          cpuProfileSource = "timeline-dart";
        } else {
          const fromHot = parseProfilerHotspots(profiling.cpuHotspots, topN);
          if (fromHot.length > 0) {
            topFunctions = fromHot.map(({ source: _, ...rest }) => rest);
            cpuProfileSource = "timeline-hotspot";
          } else {
            const fromPhase = parsePhaseCpuFallback({
              buildCount: profiling.buildPhaseAnalysis.buildCount,
              totalBuildTimeMs: profiling.buildPhaseAnalysis.totalBuildTimeMs,
              layoutCount: profiling.layoutPhaseAnalysis.layoutCount,
              totalLayoutTimeMs: profiling.layoutPhaseAnalysis.totalLayoutTimeMs,
              paintCount: profiling.paintPhaseAnalysis.paintCount,
              totalPaintTimeMs: profiling.paintPhaseAnalysis.totalPaintTimeMs,
            });
            if (fromPhase.length > 0) {
              topFunctions = fromPhase.map(({ source: _, ...rest }) => rest);
              cpuProfileSource = "timeline-hotspot";
            }
          }
        }
      }

      // 即便 VM 全局 Top 有数据，若业务 Top 仍空，用 Timeline 业务事件补全
      if (enableCpuProfile && packageName) {
        const hasBusiness = topFunctions.some((f) =>
          isBusinessCpuEntry(f, {
            projectRoot: options.projectRoot,
            packageName,
          })
        );
        if (!hasBusiness) {
          const fromDart = parseDartTimelineCpu(
            profiling.traceEvents ?? [],
            topN
          ).filter(
            (f) =>
              isAppLibFile(f.file, packageName) ||
              f.name.toLowerCase().includes("business") ||
              f.name.toLowerCase().includes("hotmethod")
          );
          if (fromDart.length > 0) {
            topFunctions = [
              ...topFunctions,
              ...fromDart.map(({ source: _, ...rest }) => rest),
            ];
            if (cpuProfileSource === "none") {
              cpuProfileSource = "timeline-dart";
            }
          }
        }
      }

      say("解析网络请求（复用 Timeline，不再二次拉取）…");
      const network = enableNetwork
        ? await this.networkCapture.stop({
            traceEvents: profiling.traceEvents ?? [],
          })
        : { total: 0, errors: 0, slow: [], requests: [] };

      let profile:
        | Awaited<ReturnType<FlutterVmServiceClient["getAllocationProfile"]>>
        | undefined;
      if (enableMemory) {
        say("采集内存快照（getAllocationProfile gc:true）…");
        profile = await this.client.getAllocationProfile(undefined, true);
      } else {
        say("跳过内存快照（enableMemory=false，可用 get_memory_snapshot 单独采集）");
      }
      const wallClockSec =
        Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;

      const result = this.buildResult({
        scenario,
        recordingWindowSec,
        wallClockSec,
        progressLog,
        profiling,
        topRebuilds: rawRebuildsForBiz,
        widgetTree,
        topFunctions,
        network,
        profile,
        memoryCollected: enableMemory,
        topN,
        rebuildTrackingEnabled,
        cpuProfileSource,
        projectRoot: options.projectRoot,
        packageName,
        isolateCpu,
      });

      if (generateAiReport) {
        say("生成 AI 规则报告…");
        result.aiAnalysis = await generateAiAnalysis(result, {
          projectRoot: options.projectRoot,
        });
      }

      say(`完成：录制 ${recordingWindowSec}s，总耗时 ${wallClockSec}s`);

      let savedPath: string | undefined;
      if (options.saveToFile) {
        const outputDir = resolveSessionOutputDir({
          outputDir: options.outputDir,
          projectRoot: options.projectRoot,
        });
        savedPath = await this.saveResult(result, outputDir);
        if (result.aiAnalysis && savedPath) {
          const mdPath = savedPath.replace(/\.json$/, ".ai.md");
          const { writeFile } = await import("fs/promises");
          await writeFile(mdPath, result.aiAnalysis, "utf-8");
        }
      }

      return { result, savedPath };
    } finally {
      this.collecting = false;
    }
  }

  private buildResult(input: {
    scenario: string;
    recordingWindowSec: number;
    wallClockSec: number;
    progressLog: string[];
    profiling: Awaited<ReturnType<Profiler["stop"]>>;
    topRebuilds: RebuildEntry[];
    widgetTree?: unknown;
    topFunctions: Awaited<ReturnType<CpuProfilerService["stop"]>>;
    network: Awaited<ReturnType<NetworkCaptureService["stop"]>>;
    profile?: Awaited<ReturnType<FlutterVmServiceClient["getAllocationProfile"]>>;
    memoryCollected: boolean;
    topN: number;
    rebuildTrackingEnabled: boolean;
    cpuProfileSource: PerformanceSessionResult["cpuProfileSource"];
    projectRoot?: string;
    packageName?: string;
    isolateCpu?: PerformanceSessionResult["isolateCpu"];
  }): PerformanceSessionResult {
    const { profiling, profile, memoryCollected } = input;
    const frames = profiling.frameAnalysis;
    const heapUsage = profile?.memoryUsage.heapUsage ?? 0;
    const heapCapacity = profile?.memoryUsage.heapCapacity ?? 0;
    const utilizationPct =
      memoryCollected && heapCapacity > 0
        ? (heapUsage / heapCapacity) * 100
        : 0;
    const bizOpts = {
      projectRoot: input.projectRoot,
      packageName: input.packageName,
    };
    const traceEvents = profiling.traceEvents ?? [];
    const targetFps = JANK_TARGET_FPS;
    const gc = parseGcStats(traceEvents);
    const imageDecode = parseImageDecodeStats(traceEvents);
    const scrollSegments = parseScrollFpsSegments(traceEvents, targetFps, 2);
    let worstScroll = pickWorstScrollSegments(scrollSegments, 3);
    let overallFps =
      scrollSegments.length > 0
        ? Math.round(
            (scrollSegments.reduce((s, x) => s + x.fps, 0) /
              scrollSegments.length) *
              10
          ) / 10
        : 0;

    // Timeline 分段为空时，用 Profiler 帧统计回退整体 FPS
    if (
      overallFps === 0 &&
      frames.totalFrames > 5 &&
      input.recordingWindowSec > 0
    ) {
      overallFps =
        Math.round((frames.totalFrames / input.recordingWindowSec) * 10) / 10;
      worstScroll = [
        {
          startSec: 0,
          endSec: Math.round(input.recordingWindowSec * 10) / 10,
          frames: frames.totalFrames,
          fps: overallFps,
          jankCount: frames.jankFrames,
          jankPct: Math.round(frames.jankPercentage * 10) / 10,
          avgMs: Math.round(frames.averageFrameTimeMs * 100) / 100,
          maxMs: Math.round(frames.maxFrameTimeMs * 100) / 100,
        },
      ];
    }

    const validMembers = (profile?.members ?? []).filter((m) => m.class?.name);
    const sortedBySize = [...validMembers]
      .sort((a, b) => b.bytesCurrent - a.bytesCurrent)
      .filter((m) => m.bytesCurrent > 0)
      .slice(0, input.topN);

    const suspicious = validMembers
      .filter(
        (m) =>
          !isVmInternal(m.class.name) && m.instancesCurrent > 500
      )
      .slice(0, 5)
      .map(
        (m) =>
          `${m.class.name}: ${m.instancesCurrent} instances`
      );

    const filesToInspect = [
      ...new Set(
        [
          ...input.topRebuilds.map((r) => r.file),
          ...input.topFunctions
            .filter((f) => isBusinessCpuEntry(f, bizOpts))
            .map((f) => f.file),
          "lib/main.dart",
        ].filter(
          (f) =>
            f &&
            f !== "unknown" &&
            (isProjectSourceFile(f) || isAppLibFile(f, input.packageName))
        )
      ),
    ].slice(0, 10);

    const topRebuilds =
      input.projectRoot && input.topRebuilds.length > 0
        ? enrichRebuildsWithBusiness(input.topRebuilds, {
            projectRoot: input.projectRoot,
            widgetTree: input.widgetTree,
            hintPaths: filesToInspect,
          })
        : input.topRebuilds;

    const projectTopFunctions = input.topFunctions
      .filter((f) => isBusinessCpuEntry(f, bizOpts))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 10)
      .map(({ sourceUrl: _, ...rest }) => rest);

    // Timeline 仅合并「明确业务埋点」事件，避免 BUILD/Rasterizer 等被默认落到 lib/main.dart
    {
      const FRAMEWORK_TIMELINE_NAMES =
        /^(build|paint|layout|rasterizer|composit|surfaceframe|vsync|frame|pipeline|gpu)/i;
      const timelineProjectFunctions = parseDartTimelineCpu(
        profiling.traceEvents ?? [],
        20
      ).filter((f) => {
        if (FRAMEWORK_TIMELINE_NAMES.test(f.name)) return false;
        if (isFrameworkOrSdkFile(f.file)) return false;
        return (
          isKnownBusinessSymbol(f.name) ||
          f.name.toLowerCase().includes("business") ||
          f.name.toLowerCase().includes("hotmethod")
        );
      });

      const existing = new Set(
        projectTopFunctions.map((f) => `${f.file}::${f.name}`)
      );
      for (const f of timelineProjectFunctions) {
        const key = `${f.file}::${f.name}`;
        if (existing.has(key)) continue;
        projectTopFunctions.push({
          name: f.name,
          file: f.file.startsWith("lib/") ? f.file : "lib/main.dart",
          selfMs: f.selfMs,
          pct: f.pct,
          severity: f.severity,
        });
        existing.add(key);
      }

      // 去掉误入的 SDK / 框架路径 / VM 符号
      for (let i = projectTopFunctions.length - 1; i >= 0; i--) {
        const f = projectTopFunctions[i];
        if (
          isFrameworkOrSdkFile(f.file) ||
          isVmInternalCpuSymbol(f.name) ||
          isMisattributedVmCpuEntry(f.name, f.file) ||
          FRAMEWORK_TIMELINE_NAMES.test(f.name) ||
          f.file.includes("lib/_http/") ||
          f.file.includes("lib/ui/") ||
          f.file.includes("lib/internal/")
        ) {
          projectTopFunctions.splice(i, 1);
        }
      }

      projectTopFunctions.sort((a, b) => b.selfMs - a.selfMs);
      projectTopFunctions.splice(10);
    }

    const vmTopFunctions = input.topFunctions
      .filter(
        (f) =>
          isVmInternalCpuSymbol(f.name) ||
          isMisattributedVmCpuEntry(f.name, f.file)
      )
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 5)
      .map(({ sourceUrl: _, name, ...rest }) => ({
        ...rest,
        rawName: name,
        name: humanizeVmCpuSymbol(name),
      }));

    // 将 lib/main.dart 的 <anonymous closure> 标注为更可读名称
    const hasHot = projectTopFunctions.some((f) =>
      f.name.includes("businessHotMethod")
    );
    if (hasHot) {
      for (const f of projectTopFunctions) {
        if (f.name.includes("anonymous") && f.file.includes("main.dart")) {
          f.name = "businessHotMethod.<anonymous>";
        }
      }
    }

    const topFunctions = input.topFunctions
      .map(({ sourceUrl: _, inclusiveMs: _i, ...rest }) => rest)
      .slice(0, input.topN);

    const hintsForAnalysis: string[] = [];

    if (!input.rebuildTrackingEnabled) {
      hintsForAnalysis.push(
        "未启用 Widget 重建追踪（profile 模式不支持 inspector 扩展，可改用 debug 模式采集重建数据）"
      );
    }

    if (frames.jankPercentage > 5) {
      hintsForAnalysis.push(
        `掉帧率偏高: ${frames.jankPercentage.toFixed(1)}%（${frames.jankFrames}/${frames.totalFrames} 帧）`
      );
    }

    for (const r of topRebuilds.filter((x) => x.count > 50).slice(0, 3)) {
      const loc = r.bizFile
        ? `${r.bizWidget ?? r.widget} @ ${r.bizFile}:${r.bizLine ?? r.line}`
        : `${r.widget} @ ${r.file}:${r.line}`;
      hintsForAnalysis.push(`过度重建: ${loc}（${r.count} 次）`);
    }

    // 不把框架 drawFrame 链路写入线索：对业务定位无帮助，改看 projectTopFunctions

    if (
      input.cpuProfileSource &&
      input.cpuProfileSource !== "vm-samples" &&
      input.topFunctions.length > 0
    ) {
      const reason = input.rebuildTrackingEnabled
        ? "debug 模式 VM getCpuSamples 常为空"
        : "profile 模式 VM 采样未命中项目符号或 Timeline 更完整";
      hintsForAnalysis.push(
        `CPU 数据来自 ${input.cpuProfileSource} 回退（${reason}）`
      );
    }

    if (memoryCollected && utilizationPct > 85) {
      hintsForAnalysis.push(`内存利用率偏高: ${utilizationPct.toFixed(1)}%`);
    }

    if (gc.count > 0) {
      const top =
        gc.topPauses && gc.topPauses.length > 0
          ? `；Top5: ${gc.topPauses
              .map((p) => `${p.name} ${p.ms}ms`)
              .join(", ")}`
          : "";
      hintsForAnalysis.push(
        `GC: ${gc.count} 次, 总停顿 ${gc.totalPauseMs}ms, 最长 ${gc.maxPauseMs}ms` +
          (gc.longPauseCount > 0
            ? `（>${8}ms 停顿 ${gc.longPauseCount} 次）`
            : "") +
          top
      );
    }
    if (gc.longPauseCount >= 3 || gc.maxPauseMs > 32) {
      hintsForAnalysis.push(
        "GC 停顿偏多/偏长，可能造成卡顿尖刺；检查每帧短生命周期对象分配"
      );
    }

    if (worstScroll.length > 0) {
      const w = worstScroll[0];
      hintsForAnalysis.push(
        `滚动最差段 ${w.startSec}-${w.endSec}s: ${w.fps} FPS, jank ${w.jankPct}% (max ${w.maxMs}ms)`
      );
    }

    if (imageDecode.count > 0) {
      const top = imageDecode.slow[0];
      const detail = top ? `；最慢 ${formatSlowImageDecodeLine(top)}` : "";
      hintsForAnalysis.push(
        `图片解码: ${imageDecode.count} 次, 合计 ${imageDecode.totalMs}ms, 最长 ${imageDecode.maxMs}ms${detail}`
      );
    } else if ((imageDecode.untimedSignals ?? 0) > 0) {
      hintsForAnalysis.push(
        `图片解码: 检测到 ${imageDecode.untimedSignals} 次信号但无时长（请确认 AppImageLoader 写入 args.ms）`
      );
    }
    if (imageDecode.maxMs > 32) {
      const top = imageDecode.slow[0];
      const where = top?.url ? `（${top.url}）` : "";
      hintsForAnalysis.push(
        `存在较慢图片解码${where}，建议预解码/缓存/缩小分辨率或使用 cached_network_image`
      );
    }

    const networkAggregate = aggregateNetworkRequests(
      input.network.requests ?? [],
      input.recordingWindowSec
    );
    const dioJsonDecode = buildDioJsonDecodeInsight({
      isolateCpu: input.isolateCpu ?? [],
      networkTotal: input.network.total,
      durationSec: input.recordingWindowSec,
      aggregate: networkAggregate,
    });
    const topParsePaths = aggregateParseCostByPath(
      input.network.requests ?? [],
      dioJsonDecode?.totalWorkerCpuMs ?? 0
    );
    const thresholdAlerts = buildThresholdAlerts({
      requests: input.network.requests ?? [],
      imageDecode,
      parsePaths: topParsePaths,
      dioWorkerCpuMs: dioJsonDecode?.totalWorkerCpuMs,
    });

    if (thresholdAlerts.summary.largeImageHits > 0 || thresholdAlerts.summary.slowDecodeHits > 0) {
      hintsForAnalysis.push(
        `大图片超阈: 体积 ${thresholdAlerts.summary.largeImageHits} 次, 慢解码 ${thresholdAlerts.summary.slowDecodeHits} 次（${thresholdAlerts.config.largeImageBytes / 1024}KB / ${thresholdAlerts.config.slowImageDecodeMs}ms）`
      );
    }
    if (thresholdAlerts.summary.largeApiHits > 0 || thresholdAlerts.summary.slowParseHits > 0) {
      hintsForAnalysis.push(
        `大接口超阈: 体积 ${thresholdAlerts.summary.largeApiHits} 个 path, 慢解析 ${thresholdAlerts.summary.slowParseHits} 个 path（${thresholdAlerts.config.largeApiBytes / 1024}KB / ${thresholdAlerts.config.slowApiParseMs}ms）`
      );
    }

    if (dioJsonDecode) {
      hintsForAnalysis.push(
        `Dio 后台 JSON 解析: ${dioJsonDecode.workerCount} worker, CPU ~${dioJsonDecode.totalWorkerCpuMs}ms, HTTP ${dioJsonDecode.networkTotal} 次 (${dioJsonDecode.networkQps} req/s), ≥${dioJsonDecode.isolateThresholdKb}KB 响应 ${dioJsonDecode.largeJsonResponseCount} 次`
      );
    } else {
      const bgIsolates = (input.isolateCpu ?? []).filter((i) => !i.isMain);
      if (bgIsolates.length > 0) {
        const busy = bgIsolates.filter((i) => i.topSelfMs > 50);
        hintsForAnalysis.push(
          `后台 isolate ${bgIsolates.length} 个` +
            (busy.length
              ? `，较忙: ${busy.map((i) => `${i.name}(${i.topName} ${i.topSelfMs}ms)`).join(", ")}`
              : "（负载较低）")
        );
      } else if ((input.isolateCpu ?? []).length <= 1) {
        hintsForAnalysis.push(
          "仅主 isolate 有 CPU 采样；重计算可考虑 compute()/Isolate 下沉"
        );
      }
    }

    for (const p of topParsePaths.slice(0, 3)) {
      hintsForAnalysis.push(
        `JSON 解析 Top: ${p.method ?? "GET"} ${p.path} ×${p.count}` +
          ` avg ${p.avgParseMs}ms 合计 ${p.totalParseMs}ms` +
          (p.totalBytes ? ` ${Math.round(p.totalBytes / 1024)}KB` : "")
      );
    }

    if (networkAggregate.topPaths.length > 0 && topParsePaths.length === 0) {
      for (const p of networkAggregate.topPaths.slice(0, 3)) {
        hintsForAnalysis.push(
          `HTTP Top: ${p.path} ×${p.count}` +
            (p.avgMs != null ? ` avg ${p.avgMs}ms` : "")
        );
      }
    }

    if (hintsForAnalysis.length === 0) {
      hintsForAnalysis.push("未发现明显性能问题，可结合代码做进一步确认。");
    }

    return {
      scenario: input.scenario,
      durationSec: input.wallClockSec,
      recordingWindowSec: input.recordingWindowSec,
      wallClockSec: input.wallClockSec,
      progressLog: input.progressLog,
      profileModeHint:
        `录制窗口 ${input.recordingWindowSec}s；总耗时含收尾分析（Android 真机常见 +30～120s）。建议使用 flutter run --profile 以获得更准确的性能数据。`,
      frames: {
        total: frames.totalFrames,
        jankCount: frames.jankFrames,
        jankPct: Math.round(frames.jankPercentage * 10) / 10,
        avgMs: Math.round(frames.averageFrameTimeMs * 100) / 100,
        p99Ms: Math.round(frames.p99FrameTimeMs * 100) / 100,
        buildMaxMs: profiling.buildPhaseAnalysis.maxBuildTimeMs,
        layoutMaxMs: profiling.layoutPhaseAnalysis.maxLayoutTimeMs,
        paintMaxMs: profiling.paintPhaseAnalysis.maxPaintTimeMs,
      },
      topFunctions,
      projectTopFunctions,
      vmTopFunctions,
      topRebuilds,
      memory: {
        collected: memoryCollected,
        heapMb: memoryCollected
          ? Math.round((heapUsage / 1024 / 1024) * 100) / 100
          : 0,
        utilizationPct: memoryCollected
          ? Math.round(utilizationPct * 10) / 10
          : 0,
        topClasses: memoryCollected
          ? sortedBySize.map((m) => ({
              name: m.class.name,
              instances: m.instancesCurrent,
              bytesMb:
                Math.round((m.bytesCurrent / 1024 / 1024) * 100) / 100,
            }))
          : [],
        suspicious: memoryCollected ? suspicious : [],
      },
      network: {
        total: input.network.total,
        errors: input.network.errors,
        slow: input.network.slow,
        qps: networkAggregate.qps,
        avgMs: networkAggregate.avgMs,
        largeJsonResponseCount: networkAggregate.largeJsonResponseCount,
        topPaths: networkAggregate.topPaths,
        topParsePaths,
      },
      thresholdAlerts,
      dioJsonDecode,
      gc,
      scrollFps: {
        segmentSec: 2,
        overallFps,
        worstSegments: worstScroll,
      },
      imageDecode,
      isolateCpu: input.isolateCpu ?? [],
      filesToInspect,
      hintsForAnalysis,
      cpuProfileSource: input.cpuProfileSource,
      aiNextStep:
        "请读取 filesToInspect 中的 Dart 源码，按 P0/P1/P2 输出优化方案（数据依据 + 代码原因 + 改法）。",
    };
  }

  private async saveResult(
    result: PerformanceSessionResult,
    outputDir: string
  ): Promise<string> {
    await mkdir(outputDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = result.scenario.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(outputDir, `${safeName}-${ts}.json`);
    await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
    return filePath;
  }
}

export function formatSessionSummary(result: PerformanceSessionResult): string {
  const rec = result.recordingWindowSec ?? result.durationSec;
  const wall = result.wallClockSec ?? result.durationSec;
  const lines = [
    `场景: ${result.scenario} | 录制: ${rec}s | 总耗时: ${wall}s | 掉帧: ${result.frames.jankPct}%`,
    `帧: 平均 ${result.frames.avgMs}ms, P99 ${result.frames.p99Ms}ms, 共 ${result.frames.total} 帧`,
  ];

  if (result.topRebuilds.length > 0) {
    const shown = result.topRebuilds.slice(0, 3);
    if (shown.length === 1) {
      const r = shown[0];
      lines.push(`重建最多: ${r.widget} ${r.count} 次 @ ${r.file}:${r.line}`);
    } else {
      lines.push("重建最多（Top3）:");
      for (const r of shown) {
        lines.push(`  - ${r.widget} ${r.count} 次 @ ${r.file}:${r.line}`);
      }
    }
  }

  if (result.projectTopFunctions[0]) {
    const f = result.projectTopFunctions[0];
    lines.push(`耗时函数最热: ${f.name} Self ${f.selfMs}ms @ ${f.file}`);
  } else if (result.vmTopFunctions?.[0]) {
    const v = result.vmTopFunctions[0];
    lines.push(
      `耗时函数最热: ${v.name} Self ${v.selfMs}ms（VM 符号，非业务；见报告 VM 热点表）`
    );
  } else {
    lines.push("耗时函数最热: 未命中（请检查 package URI 归因或延长采集）");
  }

  if (result.scrollFps?.worstSegments?.[0]) {
    const s = result.scrollFps.worstSegments[0];
    lines.push(
      `滚动最差段: ${s.startSec}-${s.endSec}s ${s.fps}FPS jank ${s.jankPct}%`
    );
  }
  if (result.gc && result.gc.count > 0) {
    lines.push(
      `GC: ${result.gc.count} 次, 最长停顿 ${result.gc.maxPauseMs}ms`
    );
  }
  if (result.imageDecode && result.imageDecode.count > 0) {
    const top = result.imageDecode.slow[0];
    lines.push(
      `图片解码: ${result.imageDecode.count} 次, 最长 ${result.imageDecode.maxMs}ms` +
        (top?.url ? ` — ${top.url}` : "")
    );
  }
  if (result.isolateCpu && result.isolateCpu.length > 0) {
    const main = result.isolateCpu.find((i) => i.isMain);
    const bg = result.isolateCpu.filter((i) => !i.isMain).length;
    lines.push(
      `Isolate: 主 top=${main?.topName ?? "-"} ${main?.topSelfMs ?? 0}ms, 后台 ${bg} 个`
    );
  }

  if (result.cpuProfileSource && result.cpuProfileSource !== "none") {
    lines.push(`CPU 来源: ${result.cpuProfileSource}`);
  }

  if (result.network.total > 0) {
    const netParts = [
      `${result.network.total} 请求`,
      `${result.network.errors} 错误`,
      `${result.network.slow.length} 个慢请求`,
    ];
    if (result.network.qps != null) netParts.push(`${result.network.qps} req/s`);
    if (result.dioJsonDecode) {
      netParts.push(
        `Dio worker ${result.dioJsonDecode.workerCount}, ~${result.dioJsonDecode.totalWorkerCpuMs}ms`
      );
    }
    lines.push(`网络: ${netParts.join(", ")}`);
  }

  lines.push(`待分析文件: ${result.filesToInspect.join(", ") || "无"}`);
  if (result.progressLog?.length) {
    lines.push("", "采集进度:");
    for (const p of result.progressLog) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("分析线索:");
  for (const h of result.hintsForAnalysis) lines.push(`- ${h}`);
  lines.push("");
  lines.push(result.aiNextStep);

  return lines.join("\n");
}
