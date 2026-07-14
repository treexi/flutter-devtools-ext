import { FlutterVmServiceClient } from "./vm-service-client.js";
import {
  normalizeSourceFile,
  severityFromRebuildCount,
  type Severity,
} from "./session-types.js";

interface WidgetLocation {
  file: string;
  line: number;
  column: number;
  name: string;
}

/**
 * Flutter.RebuiltWidgets / widgetLocationIdMap 的 locations 格式（DevTools 同款）：
 * {
 *   "file:///.../lib/main.dart": {
 *     "ids": [1, 2],
 *     "lines": [23, 32],
 *     "columns": [10, 12],
 *     "names": ["HomePage", "OrderCard"]
 *   }
 * }
 *
 * 旧版 newLocations：{ "file": [id, line, column, ...] }
 * 兼容扁平：{ "24": { file, line, column, name } }
 */
export function mergeLocationMap(
  target: Record<string, WidgetLocation>,
  source: unknown
): void {
  if (!source || typeof source !== "object") return;

  for (const [key, value] of Object.entries(
    source as Record<string, unknown>
  )) {
    if (value == null) continue;

    // 扁平：id -> { file, line, ... }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      ("file" in (value as object) ||
        "scriptUri" in (value as object) ||
        "name" in (value as object) ||
        "className" in (value as object)) &&
      !("ids" in (value as object))
    ) {
      const loc = normalizeWidgetLocation(value);
      if (loc) target[String(key)] = loc;
      continue;
    }

    // 新版：file -> { ids, lines, columns, names }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      "ids" in (value as object)
    ) {
      const entry = value as Record<string, unknown>;
      const ids = (entry.ids as unknown[]) ?? [];
      const lines = (entry.lines as unknown[]) ?? [];
      const columns = (entry.columns as unknown[]) ?? [];
      const names = (entry.names as unknown[]) ?? [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (id == null) continue;
        target[String(id)] = {
          file: key,
          line: Number(lines[i] ?? 0),
          column: Number(columns[i] ?? 0),
          name: String(names[i] ?? "Unknown"),
        };
      }
      continue;
    }

    // 旧版 newLocations：file -> [id, line, column, id, line, column, ...]
    if (Array.isArray(value)) {
      for (let i = 0; i + 2 < value.length; i += 3) {
        const id = value[i];
        if (id == null) continue;
        target[String(id)] = {
          file: key,
          line: Number(value[i + 1] ?? 0),
          column: Number(value[i + 2] ?? 0),
          name: "Unknown",
        };
      }
    }
  }
}

function normalizeWidgetLocation(raw: unknown): WidgetLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const loc = raw as Record<string, unknown>;
  const file =
    (loc.file as string) ??
    (loc.scriptUri as string) ??
    (loc.path as string) ??
    "";
  const name =
    (loc.name as string) ??
    (loc.className as string) ??
    (loc.kind as string) ??
    "Unknown";
  if (!file && name === "Unknown") return null;
  return {
    file,
    line: Number(loc.line ?? loc.lineNumber ?? 0),
    column: Number(loc.column ?? loc.columnNumber ?? 0),
    name,
  };
}

export interface RebuildEntry {
  widget: string;
  file: string;
  line: number;
  count: number;
  severity: Severity;
}

export class RebuildTrackerService {
  private client: FlutterVmServiceClient;
  private tracking = false;
  private rebuildCounts = new Map<number, number>();
  private locationMap: Record<string, WidgetLocation> = {};
  private startTime = 0;

  private rebuildListener = (event: unknown) => {
    const e = event as {
      extensionKind?: string;
      extensionData?: {
        locations?: unknown;
        newLocations?: unknown;
        events?: number[];
      };
    };
    if (e?.extensionKind !== "Flutter.RebuiltWidgets") return;

    const data = e.extensionData;
    if (data?.locations) mergeLocationMap(this.locationMap, data.locations);
    if (data?.newLocations)
      mergeLocationMap(this.locationMap, data.newLocations);
    if (!data?.events?.length) return;

    for (let i = 0; i < data.events.length; i += 2) {
      const locationId = data.events[i];
      const count = data.events[i + 1];
      this.rebuildCounts.set(
        locationId,
        (this.rebuildCounts.get(locationId) ?? 0) + count
      );
    }
  };

  constructor(client: FlutterVmServiceClient) {
    this.client = client;
  }

  get isTracking(): boolean {
    return this.tracking;
  }

  async start(): Promise<void> {
    if (this.tracking) throw new Error("Rebuild tracking already active");

    this.rebuildCounts = new Map();
    this.locationMap = {};

    try {
      await this.client.getWidgetTree();
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // inspector warmup optional
    }

    try {
      mergeLocationMap(
        this.locationMap,
        await this.client.getWidgetLocationMap()
      );
    } catch {
      // optional
    }

    this.client.on("stream:Extension", this.rebuildListener);
    await this.client.startTrackingRebuilds();
    this.tracking = true;
    this.startTime = Date.now();
  }

  async stop(topN = 15): Promise<RebuildEntry[]> {
    if (!this.tracking) throw new Error("Rebuild tracking not active");

    try {
      mergeLocationMap(
        this.locationMap,
        await this.client.getWidgetLocationMap()
      );
    } catch {
      // best effort before stop
    }

    await this.client.stopTrackingRebuilds();
    this.client.off("stream:Extension", this.rebuildListener);
    this.tracking = false;

    try {
      mergeLocationMap(
        this.locationMap,
        await this.client.getWidgetLocationMap()
      );
    } catch {
      // best effort
    }

    const entries: RebuildEntry[] = [];

    for (const [locationId, count] of this.rebuildCounts) {
      const loc = this.locationMap[String(locationId)];
      if (loc) {
        const file = normalizeSourceFile(loc.file);
        entries.push({
          widget: loc.name,
          file,
          line: loc.line,
          count,
          severity: severityFromRebuildCount(count),
        });
      } else {
        entries.push({
          widget: `Unknown(${locationId})`,
          file: "unknown",
          line: 0,
          count,
          severity: severityFromRebuildCount(count),
        });
      }
    }

    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, topN);
  }

  getDurationSec(): number {
    if (!this.startTime) return 0;
    return (Date.now() - this.startTime) / 1000;
  }
}
