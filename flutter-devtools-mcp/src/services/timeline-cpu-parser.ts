import type { TimelineEvent } from "./vm-service-client.js";
import {
  isProjectSourceFile,
  normalizeSourceFile,
  severityFromPct,
  type Severity,
} from "./session-types.js";

export interface TimelineCpuEntry {
  name: string;
  file: string;
  selfMs: number;
  pct: number;
  severity: Severity;
  source: "timeline-dart" | "timeline-hotspot";
}

const SKIP_EVENT_NAMES = new Set([
  "Frame",
  "Vsync",
  "Animator::BeginFrame",
  "GPURasterizer::Draw",
]);

function readEventLocation(event: TimelineEvent): {
  name: string;
  file: string;
} {
  const args = event.args ?? {};
  const nested = (args.event as Record<string, unknown> | undefined) ?? args;
  const name =
    (nested.name as string) ??
    (nested.function as string) ??
    (args.name as string) ??
    event.name;
  const file =
    (nested.uri as string) ??
    (nested.file as string) ??
    (args.uri as string) ??
    (args.file as string) ??
    "";
  return { name, file };
}

function collectTimedEvents(events: TimelineEvent[]): Array<{
  name: string;
  cat?: string;
  durUs: number;
  args?: Record<string, unknown>;
}> {
  const timed: Array<{
    name: string;
    cat?: string;
    durUs: number;
    args?: Record<string, unknown>;
  }> = [];

  for (const event of events) {
    if (event.ph === "X" && event.dur && event.dur > 0) {
      timed.push({
        name: event.name,
        cat: event.cat,
        durUs: event.dur,
        args: event.args,
      });
    }
  }

  // dart:developer Timeline.timeSync 常见为 B/E 对，而非 complete(X)
  const begins = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    if (event.ph !== "B") continue;
    const key = `${event.name}|${event.pid ?? ""}|${event.tid ?? ""}`;
    const list = begins.get(key) ?? [];
    list.push(event);
    begins.set(key, list);
  }
  for (const event of events) {
    if (event.ph !== "E") continue;
    const key = `${event.name}|${event.pid ?? ""}|${event.tid ?? ""}`;
    const list = begins.get(key);
    if (!list?.length) continue;
    const begin = list.shift()!;
    const durUs = event.ts - begin.ts;
    if (durUs > 0) {
      timed.push({
        name: event.name,
        cat: event.cat ?? begin.cat,
        durUs,
        args: event.args ?? begin.args,
      });
    }
  }

  return timed;
}

/** 从 Timeline 的 Dart build/布局等事件提取带源码路径的 CPU 热点（debug 模式回退） */
export function parseDartTimelineCpu(
  events: TimelineEvent[],
  topN: number
): TimelineCpuEntry[] {
  const buckets = new Map<string, { name: string; file: string; selfMs: number }>();

  for (const event of collectTimedEvents(events)) {
    if (SKIP_EVENT_NAMES.has(event.name)) continue;

    const cat = (event.cat ?? "").toLowerCase();
    const isDart = cat.includes("dart") || cat.includes("flutter");
    const lowerName = event.name.toLowerCase();
    const isBuildPhase =
      lowerName.includes("build") ||
      lowerName.includes("layout") ||
      lowerName.includes("paint") ||
      lowerName.includes("rebuild");
    const isBusinessNamed =
      lowerName.includes("business") ||
      lowerName.includes("hotmethod") ||
      lowerName.includes("homepage") ||
      lowerName.includes("ordercard");

    const selfMs = event.durUs / 1000;
    if (selfMs < 0.05 && !isBuildPhase && !isBusinessNamed) continue;

    if (!isDart && !isBuildPhase && !isBusinessNamed && selfMs < 1) continue;

    const { name, file } = readEventLocation({
      name: event.name,
      cat: event.cat,
      ph: "X",
      ts: 0,
      dur: event.durUs,
      args: event.args,
    } as TimelineEvent);
    const normalizedFile = file ? normalizeSourceFile(file) : "";
    if (normalizedFile && !isProjectSourceFile(normalizedFile) && !isBusinessNamed) {
      continue;
    }

    const displayName = name || event.name;
    const displayFile =
      normalizedFile && isProjectSourceFile(normalizedFile)
        ? normalizedFile
        : isBusinessNamed
          ? "lib/main.dart"
          : normalizedFile || "lib/main.dart";

    const key = `${displayFile}::${displayName}`;
    const prev = buckets.get(key);
    if (prev) {
      prev.selfMs += selfMs;
    } else {
      buckets.set(key, {
        name: displayName,
        file: displayFile,
        selfMs,
      });
    }
  }

  const entries = [...buckets.values()].sort((a, b) => b.selfMs - a.selfMs);
  const total = entries.reduce((s, e) => s + e.selfMs, 0) || 1;

  return entries.slice(0, topN).map((e) => {
    const pct = (e.selfMs / total) * 100;
    return {
      name: e.name,
      file: e.file,
      selfMs: Math.round(e.selfMs * 10) / 10,
      pct: Math.round(pct * 10) / 10,
      severity: severityFromPct(pct),
      source: "timeline-dart" as const,
    };
  });
}

/** 从 Profiler 聚合热点回退（无文件信息） */
export function parseProfilerHotspots(
  hotspots: Array<{
    name: string;
    category: string;
    totalDurationMs: number;
  }>,
  topN: number
): TimelineCpuEntry[] {
  const filtered = hotspots
    .filter(
      (h) =>
        h.totalDurationMs > 0.5 &&
        !SKIP_EVENT_NAMES.has(h.name) &&
        !h.name.startsWith("_")
    )
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  const total =
    filtered.reduce((s, h) => s + h.totalDurationMs, 0) || 1;

  return filtered.slice(0, topN).map((h) => {
    const pct = (h.totalDurationMs / total) * 100;
    const file =
      h.name.toLowerCase().includes("build") ||
      h.name.toLowerCase().includes("layout")
        ? "lib/main.dart"
        : h.category.toLowerCase().includes("dart")
          ? "lib/main.dart"
          : "lib/main.dart";
    return {
      name: h.name,
      file,
      selfMs: Math.round(h.totalDurationMs * 10) / 10,
      pct: Math.round(pct * 10) / 10,
      severity: severityFromPct(pct),
      source: "timeline-hotspot" as const,
    };
  });
}

/** 用 Build/Layout/Paint 阶段统计合成 CPU 条目（最后回退） */
export function parsePhaseCpuFallback(phase: {
  buildCount: number;
  totalBuildTimeMs: number;
  layoutCount: number;
  totalLayoutTimeMs: number;
  paintCount: number;
  totalPaintTimeMs: number;
}): TimelineCpuEntry[] {
  const items = [
    { name: "Build", ms: phase.totalBuildTimeMs, count: phase.buildCount },
    { name: "Layout", ms: phase.totalLayoutTimeMs, count: phase.layoutCount },
    { name: "Paint", ms: phase.totalPaintTimeMs, count: phase.paintCount },
  ].filter((i) => i.ms > 0);

  const total = items.reduce((s, i) => s + i.ms, 0) || 1;
  return items.map((i) => ({
    name: `${i.name} (phase aggregate)`,
    file: "lib/main.dart",
    selfMs: Math.round(i.ms * 10) / 10,
    pct: Math.round((i.ms / total) * 1000) / 10,
    severity: severityFromPct((i.ms / total) * 100),
    source: "timeline-hotspot" as const,
  }));
}
