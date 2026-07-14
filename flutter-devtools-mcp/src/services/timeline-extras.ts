import type { TimelineEvent } from "./vm-service-client.js";
import { JANK_FRAME_BUDGET_MS } from "./session-types.js";

export interface GcPauseEntry {
  name: string;
  ms: number;
}

export interface GcStats {
  count: number;
  totalPauseMs: number;
  maxPauseMs: number;
  avgPauseMs: number;
  /** 与掉帧可能相关的长停顿（>8ms）次数 */
  longPauseCount: number;
  /** 最长停顿 Top5（按 ms 降序） */
  topPauses: GcPauseEntry[];
}

export interface ImageDecodeEntry {
  name: string;
  ms: number;
  /** 图片 URL（来自 Timeline arguments） */
  url?: string;
  width?: number;
  height?: number;
  /** 原始字节数 */
  bytes?: number;
}

export interface ImageDecodeStats {
  count: number;
  totalMs: number;
  maxMs: number;
  slow: ImageDecodeEntry[];
  /** 检测到解码信号但无有效时长（常见于跨 await 的 B/E 丢失） */
  untimedSignals?: number;
}

export interface ScrollFpsSegment {
  /** 段起始（相对采集起点，秒） */
  startSec: number;
  endSec: number;
  frames: number;
  fps: number;
  jankCount: number;
  jankPct: number;
  avgMs: number;
  maxMs: number;
}

function eventDurationMs(event: TimelineEvent): number {
  if (event.ph === "X" && event.dur && event.dur > 0) {
    return event.dur / 1000;
  }
  return 0;
}

function isGcEvent(event: TimelineEvent): boolean {
  const cat = (event.cat ?? "").toLowerCase();
  const name = (event.name ?? "").toLowerCase();
  if (cat.includes("gc")) return true;
  return (
    name.includes("collect") ||
    name.includes("scavenge") ||
    name.includes("marksweep") ||
    name.includes("mark-sweep") ||
    name.includes("concurrentmark") ||
    name.includes("evacuate") ||
    name.startsWith("gc")
  );
}

function isImageDecodeEvent(event: TimelineEvent): boolean {
  const name = (event.name ?? "").toLowerCase();
  const cat = (event.cat ?? "").toLowerCase();
  return (
    name.includes("imagedecode") ||
    name.includes("image decode") ||
    name.includes("decodeimage") ||
    name.includes("image_decode") ||
    name.includes("instantiateimodecodec") ||
    name.includes("instantiate image codec") ||
    name.includes("codec::getnextframe") ||
    name.includes("getnextframe") ||
    name.includes("multiframecodec") ||
    name.includes("ui.image") ||
    name.includes("imagedescriptor") ||
    name.includes("imageprovider") ||
    name.includes("networkimage") ||
    name.includes("ordercard.imageframe") ||
    name.includes("imagedecodedemo") ||
    name.includes("app.imagedecode") ||
    (cat.includes("dart") && name.includes("decode") && name.includes("image")) ||
    (name.includes("decode") &&
      (name.includes("image") || name.includes("codec") || name.includes("jpeg") || name.includes("png") || name.includes("webp"))) ||
    name.includes("skiaimagegenerator") ||
    (name.includes("impeller") &&
      name.includes("texture") &&
      name.includes("decode"))
  );
}

function isCanonicalFrameEvent(name: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  // 优先完整帧边界，避免 beginframe+drawframe+pipeline 重复计数抬高 FPS
  return (
    n === "frame" ||
    n === "flutter.frame" ||
    n === "flutter frametiming" ||
    n.includes("flutter.frame")
  );
}

function isFrameLikeEvent(name: string): boolean {
  if (!name) return false;
  if (isCanonicalFrameEvent(name)) return true;
  const n = name.toLowerCase();
  return (
    n.includes("pipeline produce") ||
    n.includes("pipelineproduce") ||
    n === "animator::beginframe" ||
    n === "enginesuper::beginframe"
  );
}

/** 从 Timeline 提取帧耗时序列（ms）及时间戳（micros） */
export function extractFrameTimings(
  events: TimelineEvent[]
): Array<{ ts: number; ms: number }> {
  const out: Array<{ ts: number; ms: number }> = [];

  // 1) 优先只用 canonical Flutter.Frame
  for (const event of events) {
    if (event.ph !== "X" || !event.dur || event.dur <= 0) continue;
    if (!isCanonicalFrameEvent(event.name)) continue;
    const ms = event.dur / 1000;
    if (ms <= 0 || ms > 1000) continue;
    out.push({ ts: event.ts, ms });
  }

  // 2) 无 canonical 时，用 pipeline produce / beginframe（每种 tid 去重到 ~16ms 桶）
  if (out.length < 5) {
    const raw: Array<{ ts: number; ms: number }> = [];
    for (const event of events) {
      if (event.ph !== "X" || !event.dur || event.dur <= 0) continue;
      if (!isFrameLikeEvent(event.name) || isCanonicalFrameEvent(event.name)) {
        continue;
      }
      const ms = event.dur / 1000;
      if (ms <= 0 || ms > 1000) continue;
      raw.push({ ts: event.ts, ms });
    }
    raw.sort((a, b) => a.ts - b.ts);
    let lastTs = -Infinity;
    for (const t of raw) {
      // 同一显示刷新周期内只计 1 帧（~8ms 去抖，兼容 120Hz）
      if (t.ts - lastTs < 8000) continue;
      out.push(t);
      lastTs = t.ts;
    }
  }

  // 3) B/E 配对兜底（仅 canonical）
  if (out.length === 0) {
    const begins = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      if (event.ph !== "B" || !isCanonicalFrameEvent(event.name)) continue;
      const key = `${event.name}|${event.tid}`;
      const list = begins.get(key) ?? [];
      list.push(event);
      begins.set(key, list);
    }
    for (const event of events) {
      if (event.ph !== "E" || !isCanonicalFrameEvent(event.name)) continue;
      const key = `${event.name}|${event.tid}`;
      const list = begins.get(key);
      if (!list?.length) continue;
      const begin = list.shift()!;
      const ms = (event.ts - begin.ts) / 1000;
      if (ms > 0 && ms < 1000) out.push({ ts: begin.ts, ms });
    }
  }

  // 4) 仍很少：用 drawFrame / buildScope，并按刷新周期去抖
  if (out.length < 5) {
    const raw: Array<{ ts: number; ms: number }> = [];
    for (const event of events) {
      if (event.ph !== "X" || !event.dur) continue;
      const n = event.name.toLowerCase();
      if (
        n === "drawframe" ||
        n.includes("widgetsbinding.drawframe") ||
        n.includes("buildscope") ||
        n === "pipeline produce" ||
        n.includes("pipelineproduce")
      ) {
        const ms = event.dur / 1000;
        if (ms > 0 && ms < 500) raw.push({ ts: event.ts, ms });
      }
    }
    raw.sort((a, b) => a.ts - b.ts);
    let lastTs = -Infinity;
    for (const t of raw) {
      if (t.ts - lastTs < 8000) continue;
      out.push(t);
      lastTs = t.ts;
    }
  }

  // 最终再按 8ms 去抖，防止同周期多事件
  const deduped: Array<{ ts: number; ms: number }> = [];
  let prev = -Infinity;
  for (const t of out.sort((a, b) => a.ts - b.ts)) {
    if (t.ts - prev < 8000) continue;
    deduped.push(t);
    prev = t.ts;
  }
  return deduped;
}

export function parseGcStats(events: TimelineEvent[]): GcStats {
  const pauses: GcPauseEntry[] = [];

  for (const event of events) {
    if (!isGcEvent(event)) continue;
    let ms = eventDurationMs(event);
    if (ms <= 0 && event.ph === "B") {
      // 部分 GC 用 B/E；在 collectTimed 风格里再扫一遍
      continue;
    }
    if (ms > 0 && ms < 5000) {
      pauses.push({ name: event.name || "GC", ms });
    }
  }

  // B/E 配对
  const begins = new Map<string, number[]>();
  for (const event of events) {
    if (event.ph !== "B" || !isGcEvent(event)) continue;
    const key = `${event.name}|${event.tid}`;
    const list = begins.get(key) ?? [];
    list.push(event.ts);
    begins.set(key, list);
  }
  for (const event of events) {
    if (event.ph !== "E" || !isGcEvent(event)) continue;
    const key = `${event.name}|${event.tid}`;
    const list = begins.get(key);
    if (!list?.length) continue;
    const start = list.shift()!;
    const ms = (event.ts - start) / 1000;
    if (ms > 0 && ms < 5000) {
      pauses.push({ name: event.name || "GC", ms });
    }
  }

  const count = pauses.length;
  const totalPauseMs = pauses.reduce((s, x) => s + x.ms, 0);
  const maxPauseMs = count ? Math.max(...pauses.map((x) => x.ms)) : 0;
  const avgPauseMs = count ? totalPauseMs / count : 0;
  const longPauseCount = pauses.filter((x) => x.ms > 8).length;
  const topPauses = [...pauses]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((p) => ({
      name: p.name,
      ms: Math.round(p.ms * 10) / 10,
    }));

  return {
    count,
    totalPauseMs: Math.round(totalPauseMs * 10) / 10,
    maxPauseMs: Math.round(maxPauseMs * 10) / 10,
    avgPauseMs: Math.round(avgPauseMs * 10) / 10,
    longPauseCount,
    topPauses,
  };
}

function readImageArgs(args?: Record<string, unknown>): {
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** 业务埋点写入的耗时（ms）；跨 await 时 B/E 常丢，靠此字段 */
  ms?: number;
} {
  if (!args) return {};
  // dart:developer Timeline 常把业务参数放在 args 或 args.arguments
  const nested =
    (args.arguments as Record<string, unknown> | undefined) ??
    (args.args as Record<string, unknown> | undefined) ??
    args;

  const urlRaw =
    nested.url ?? nested.uri ?? nested.src ?? nested.imageUrl ?? nested.path;
  const url =
    typeof urlRaw === "string" && urlRaw.length > 0 ? urlRaw : undefined;

  const toNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
    return undefined;
  };

  return {
    url,
    width: toNum(nested.width ?? nested.w),
    height: toNum(nested.height ?? nested.h),
    bytes: toNum(nested.bytes ?? nested.byteCount ?? nested.size),
    ms: toNum(nested.ms ?? nested.durationMs ?? nested.elapsedMs),
  };
}

function formatImageMeta(e: {
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
}): string {
  const parts: string[] = [];
  if (e.url) {
    // 过长 URL 截断，保留域名+路径尾部便于排查
    const u = e.url.length > 80 ? `${e.url.slice(0, 40)}…${e.url.slice(-30)}` : e.url;
    parts.push(u);
  }
  if (e.width && e.height) parts.push(`${e.width}x${e.height}`);
  if (e.bytes && e.bytes > 0) {
    const kb = Math.round((e.bytes / 1024) * 10) / 10;
    parts.push(`${kb}KB`);
  }
  return parts.join(", ");
}

export function parseImageDecodeStats(
  events: TimelineEvent[],
  slowThresholdMs = 16
): ImageDecodeStats {
  const entries: ImageDecodeEntry[] = [];
  let untimedSignals = 0;

  for (const event of events) {
    if (!isImageDecodeEvent(event)) continue;
    const meta = readImageArgs(event.args);

    // instant：优先读业务写入的 args.ms（跨 await 时 B/E 常丢）
    if (event.ph === "i" || event.ph === "I" || event.ph === "n") {
      if (meta.ms != null && meta.ms > 0 && meta.ms < 10000) {
        entries.push({
          name: event.name,
          ms: meta.ms,
          url: meta.url,
          width: meta.width,
          height: meta.height,
          bytes: meta.bytes,
        });
      } else if (meta.url) {
        untimedSignals += 1;
      } else {
        untimedSignals += 1;
      }
      continue;
    }

    let ms = eventDurationMs(event);
    if (ms <= 0 && meta.ms != null && meta.ms > 0) ms = meta.ms;
    if (ms <= 0) {
      if (meta.url) untimedSignals += 1;
      continue;
    }
    if (ms > 10000) continue;
    entries.push({
      name: event.name,
      ms,
      url: meta.url,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
    });
  }

  // B/E：从 begin 取 arguments（url/尺寸），时长用 E-B
  const begins = new Map<
    string,
    Array<{ ts: number; args?: Record<string, unknown> }>
  >();
  for (const event of events) {
    if (event.ph !== "B" || !isImageDecodeEvent(event)) continue;
    const key = `${event.name}|${event.tid}`;
    const list = begins.get(key) ?? [];
    list.push({ ts: event.ts, args: event.args });
    begins.set(key, list);
  }
  for (const event of events) {
    if (event.ph !== "E" || !isImageDecodeEvent(event)) continue;
    const key = `${event.name}|${event.tid}`;
    const list = begins.get(key);
    if (!list?.length) continue;
    const begin = list.shift()!;
    const ms = (event.ts - begin.ts) / 1000;
    if (ms > 0 && ms < 10000) {
      entries.push({
        name: event.name,
        ms,
        ...readImageArgs(begin.args ?? event.args),
      });
    }
  }

  // 宽匹配兜底：名称含 image/codec 且有时长的 Dart/Embedder 事件
  if (entries.filter((e) => e.ms > 0).length === 0) {
    for (const event of events) {
      if (event.ph !== "X" || !event.dur || event.dur <= 0) continue;
      const n = (event.name ?? "").toLowerCase();
      if (
        (n.includes("image") ||
          n.includes("codec") ||
          n.includes("jpeg") ||
          n.includes("webp")) &&
        (n.includes("decode") ||
          n.includes("compress") ||
          n.includes("upload") ||
          n.includes("raster"))
      ) {
        const ms = event.dur / 1000;
        if (ms > 0.1 && ms < 10000) {
          entries.push({ name: event.name, ms, ...readImageArgs(event.args) });
        }
      }
    }
  }

  // 同 url 去重：优先保留有时长的条目
  const byUrl = new Map<string, ImageDecodeEntry>();
  const noUrl: ImageDecodeEntry[] = [];
  for (const e of entries) {
    if (e.ms <= 0) continue;
    if (!e.url) {
      noUrl.push(e);
      continue;
    }
    const prev = byUrl.get(e.url);
    if (!prev || e.ms > prev.ms) byUrl.set(e.url, e);
  }
  const timed = [...byUrl.values(), ...noUrl];

  const totalMs = timed.reduce((s, e) => s + e.ms, 0);
  const maxMs = timed.length ? Math.max(...timed.map((e) => e.ms)) : 0;
  const slow = [...timed]
    .filter((e) => e.ms >= slowThresholdMs)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((e) => ({
      name: e.name,
      ms: Math.round(e.ms * 10) / 10,
      url: e.url,
      width: e.width,
      height: e.height,
      bytes: e.bytes,
    }));

  // 仅有无时长信号时 count=0，避免「5 次最长 0ms」假正常
  const count = timed.length;

  return {
    count,
    totalMs: Math.round(totalMs * 10) / 10,
    maxMs: Math.round(maxMs * 10) / 10,
    slow,
    ...(untimedSignals > 0 && count === 0 ? { untimedSignals } : {}),
  };
}

/** 供报告展示：慢解码一行文案 */
export function formatSlowImageDecodeLine(e: ImageDecodeEntry): string {
  const meta = formatImageMeta(e);
  return meta
    ? `${e.name} ${e.ms}ms — ${meta}`
    : `${e.name} ${e.ms}ms`;
}

/**
 * 将帧序列按固定窗口切成滚动/交互段，计算每段 FPS 与 jank。
 * @param windowSec 窗口秒数，默认 2s
 */
export function parseScrollFpsSegments(
  events: TimelineEvent[],
  targetFps: number,
  windowSec = 2
): ScrollFpsSegment[] {
  const timings = extractFrameTimings(events);
  if (timings.length === 0) return [];

  const targetFrameMs = JANK_FRAME_BUDGET_MS;
  const originTs = timings[0].ts;
  const windowUs = windowSec * 1_000_000;
  const lastTs = timings[timings.length - 1].ts;
  const segments: ScrollFpsSegment[] = [];

  for (
    let start = originTs;
    start <= lastTs;
    start += windowUs
  ) {
    const end = start + windowUs;
    const bucket = timings.filter((t) => t.ts >= start && t.ts < end);
    if (bucket.length === 0) continue;

    const avgMs =
      bucket.reduce((s, t) => s + t.ms, 0) / bucket.length;
    const maxMs = Math.max(...bucket.map((t) => t.ms));
    const jankCount = bucket.filter((t) => t.ms > targetFrameMs).length;
    const durationSec = windowSec;
    const fps = Math.round((bucket.length / durationSec) * 10) / 10;

    segments.push({
      startSec: Math.round(((start - originTs) / 1_000_000) * 10) / 10,
      endSec: Math.round(((end - originTs) / 1_000_000) * 10) / 10,
      frames: bucket.length,
      fps,
      jankCount,
      jankPct: Math.round((jankCount / bucket.length) * 1000) / 10,
      avgMs: Math.round(avgMs * 100) / 100,
      maxMs: Math.round(maxMs * 100) / 100,
    });
  }

  return segments;
}

/** 找出 jank 最严重的若干段，供摘要展示 */
export function pickWorstScrollSegments(
  segments: ScrollFpsSegment[],
  topN = 3
): ScrollFpsSegment[] {
  return [...segments]
    .filter((s) => s.frames >= 3)
    .sort((a, b) => b.jankPct - a.jankPct || b.maxMs - a.maxMs)
    .slice(0, topN);
}
