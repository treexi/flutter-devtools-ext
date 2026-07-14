import { FlutterVmServiceClient } from "./vm-service-client.js";
import { isDioJsonDecodeIsolate } from "./network-aggregate.js";
import {
  isAppLibFile,
  isProjectSourceFile,
  normalizeSourceFile,
  severityFromPct,
  type Severity,
} from "./session-types.js";

/** 避免 Android 上 isolate 过多时 getCpuSamples 过慢 */
const MAX_ISOLATE_CPU_TARGETS = 10;

export interface CpuFunctionEntry {
  name: string;
  file: string;
  selfMs: number;
  pct: number;
  severity: Severity;
  sourceUrl?: string;
  /** 含本函数及子调用的采样时间 */
  inclusiveMs?: number;
}

export class CpuProfilerService {
  private client: FlutterVmServiceClient;
  private active = false;
  private originMicros = 0;
  private enabledProfiler = false;
  private packageName?: string;

  constructor(client: FlutterVmServiceClient) {
    this.client = client;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 可选：传入 pubspec name，用于 package:<name>/ 业务归因 */
  setPackageName(name?: string): void {
    this.packageName = name;
  }

  async start(): Promise<void> {
    if (this.active) throw new Error("CPU profiler already active");

    // 提高采样密度，降低业务短函数漏采概率（默认常 ~1000µs）
    try {
      await this.client.setFlag("profile_period", "250");
    } catch {
      // 部分设备可能拒绝修改
    }

    const profilerFlag = await this.client.getFlag("profiler");
    if (profilerFlag !== "true") {
      try {
        await this.client.setFlag("profiler", "true");
        this.enabledProfiler = true;
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        // profile 模式可能已默认开启采样
      }
    }

    this.originMicros = await this.client.getVMTimelineMicros();
    this.active = true;
  }

  async stop(topN = 15): Promise<CpuFunctionEntry[]> {
    if (!this.active) throw new Error("CPU profiler not active");

    const endMicros = await this.client.getVMTimelineMicros();
    const extentMicros = Math.max(endMicros - this.originMicros, 1);

    let samples;
    try {
      samples = await this.client.getCpuSamples(
        this.originMicros,
        extentMicros
      );
    } finally {
      if (this.enabledProfiler) {
        try {
          await this.client.setFlag("profiler", "false");
        } catch {
          // best effort
        }
        this.enabledProfiler = false;
      }
      this.active = false;
    }

    return this.parseSamples(samples, topN);
  }

  /**
   * 在 stop 前调用：对 VM 中各非系统 isolate 采样，对比主/后台 CPU。
   */
  async sampleAllIsolates(topN = 5): Promise<
    Array<{
      isolateId: string;
      name: string;
      isMain: boolean;
      sampleCount: number;
      topSelfMs: number;
      topName: string;
    }>
  > {
    if (!this.active) return [];

    const endMicros = await this.client.getVMTimelineMicros();
    const extentMicros = Math.max(endMicros - this.originMicros, 1);
    const mainId = this.client.mainIsolateId;
    let isolates: Array<{ id: string; name: string; isSystemIsolate: boolean }> =
      [];
    try {
      const vm = await this.client.getVM();
      isolates = vm.isolates ?? [];
    } catch {
      return [];
    }

    const results: Array<{
      isolateId: string;
      name: string;
      isMain: boolean;
      sampleCount: number;
      topSelfMs: number;
      topName: string;
    }> = [];

    const nonSystem = isolates.filter((i) => !i.isSystemIsolate);
    const mainIso = nonSystem.find((i) => i.id === mainId);
    const others = nonSystem.filter((i) => i.id !== mainId);
    const seenNames = new Set<string>();
    const picked: typeof nonSystem = [];
    if (mainIso) picked.push(mainIso);
    for (const iso of others) {
      const key = iso.name || iso.id;
      if (isDioJsonDecodeIsolate(key) && seenNames.has("_decodeUtf8ToJson")) {
        continue;
      }
      if (isDioJsonDecodeIsolate(key)) seenNames.add("_decodeUtf8ToJson");
      picked.push(iso);
      if (picked.length >= MAX_ISOLATE_CPU_TARGETS) break;
    }

    for (const iso of picked) {
      try {
        const samples = await this.client.getCpuSamples(
          this.originMicros,
          extentMicros,
          iso.id
        );
        const parsed = this.parseSamples(samples, topN);
        const sampleCount =
          (samples as { sampleCount?: number }).sampleCount ??
          ((samples as { samples?: unknown[] }).samples?.length ?? 0);
        results.push({
          isolateId: iso.id,
          name: iso.name || iso.id,
          isMain: iso.id === mainId,
          sampleCount,
          topSelfMs: parsed[0]?.selfMs ?? 0,
          topName: parsed[0]?.name ?? "-",
        });
      } catch {
        // 部分 isolate 不支持 getCpuSamples
      }
    }

    return results.sort((a, b) => Number(b.isMain) - Number(a.isMain));
  }

  /**
   * 解析完整采样表，返回「全局 TopN ∪ 业务 TopN」。
   * 业务方法可能 Self 占比低，若只截全局 Top 会被框架函数挤掉。
   */
  private parseSamples(
    samples: {
      functions?: Array<{
        function?: { name?: string };
        resolvedUrl?: string;
        exclusiveTicks?: number;
        inclusiveTicks?: number;
      }>;
      samplePeriod?: number;
    },
    topN: number
  ): CpuFunctionEntry[] {
    const period = samples.samplePeriod ?? 250;
    const functions = samples.functions ?? [];

    const entries = functions
      .map((f) => {
        const exclusive = f.exclusiveTicks ?? 0;
        const inclusive = f.inclusiveTicks ?? 0;
        const ticks = exclusive > 0 ? exclusive : inclusive;
        return { f, ticks, exclusive, inclusive };
      })
      .filter(({ ticks }) => ticks > 0)
      .map(({ f, ticks, exclusive, inclusive }) => {
        const selfMs = (ticks * period) / 1000;
        const inclusiveMs = (inclusive * period) / 1000;
        const url = f.resolvedUrl ?? "";
        const name = f.function?.name ?? "unknown";
        const file = url ? normalizeSourceFile(url) : name;
        return {
          name,
          file,
          url,
          selfMs,
          inclusiveMs,
          exclusive,
        };
      });

    const totalSelfMs = entries.reduce((s, e) => s + e.selfMs, 0) || 1;

    const ranked = entries
      .sort((a, b) => b.selfMs - a.selfMs)
      .map((e) => {
        const pct = (e.selfMs / totalSelfMs) * 100;
        const isApp =
          isAppLibFile(e.file, this.packageName) ||
          isAppLibFile(e.url, this.packageName) ||
          (Boolean(this.packageName) &&
            e.url.toLowerCase().includes(`package:${this.packageName}/`));
        return {
          name: e.name,
          file: e.file,
          selfMs: Math.round(e.selfMs * 10) / 10,
          inclusiveMs: Math.round(e.inclusiveMs * 10) / 10,
          pct: Math.round(pct * 10) / 10,
          severity: severityFromPct(pct),
          isProject:
            isApp ||
            isProjectSourceFile(e.url || e.file) ||
            isAppLibFile(e.file, this.packageName),
          isApp,
          sourceUrl: e.url || undefined,
        };
      });

    const projectMatches = ranked.filter(
      (e) =>
        e.isApp ||
        (e.isProject && isAppLibFile(e.file, this.packageName)) ||
        // 无 URL 时：按已知业务符号兜底（勿用泛化 "build"，会误收框架）
        (!e.sourceUrl &&
          (e.name.includes("OrderCard") ||
            e.name.includes("HomePage") ||
            e.name.includes("businessHotMethod") ||
            e.name.includes("_HomePageState")))
    );

    // 全局 Top：过滤纯噪（unknown 且无文件）后取 TopN
    const globalTop = ranked
      .filter((e) => e.name !== "unknown" || e.sourceUrl)
      .slice(0, topN);

    // 合并业务条目（按 Self），即使不在全局 Top 也纳入
    const byKey = new Map<string, (typeof ranked)[0]>();
    for (const e of globalTop) {
      byKey.set(`${e.file}::${e.name}`, e);
    }
    for (const e of projectMatches.slice(0, Math.max(topN, 20))) {
      const key = `${e.file}::${e.name}`;
      if (!byKey.has(key)) byKey.set(key, e);
    }

    // profile/AOT：resolvedUrl 全空时，用全局 Top 保底，避免列表为空
    let picked = [...byKey.values()].sort((a, b) => b.selfMs - a.selfMs);
    if (picked.length === 0) {
      picked = ranked.slice(0, topN * 2);
    }

    return picked.slice(0, topN * 2).map(({ isProject: _p, isApp: _a, ...rest }) => rest);
  }
}
