import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  isFrameworkOrSdkFile,
  normalizeSourceFile,
  type Severity,
} from "./session-types.js";

export interface RebuildEntry {
  widget: string;
  file: string;
  line: number;
  count: number;
  severity: Severity;
  bizWidget?: string;
  bizFile?: string;
  bizLine?: number;
  bizSource?: "direct" | "runtime" | "static" | "inferred";
  /** 仅 static 时保留，报告里作「代码库参考」脚注，不作当前屏定位 */
  staticRefNote?: string;
}

interface WidgetNode {
  description?: string;
  type?: string;
  widgetRuntimeType?: string;
  children?: WidgetNode[];
  createdByLocalProject?: boolean;
  creationLocation?: {
    file?: string;
    line?: number;
    column?: number;
    name?: string;
  };
}

interface BizLocation {
  widget: string;
  file: string;
  line: number;
}

const GENERIC_WIDGET_NAMES = new Set([
  "Text",
  "RichText",
  "Container",
  "Row",
  "Column",
  "Stack",
  "Padding",
  "SizedBox",
  "Expanded",
  "Flexible",
  "Align",
  "Center",
  "GestureDetector",
  "InkWell",
  "Material",
  "Scaffold",
  "Obx",
  "FutureBuilder",
  "StreamBuilder",
  "LayoutBuilder",
  "AnimatedBuilder",
  "Builder",
  "ClipRRect",
  "ClipOval",
  "Opacity",
  "Transform",
  "Positioned",
  "Wrap",
  "ListView",
  "GridView",
  "SingleChildScrollView",
  "CustomScrollView",
  "SliverList",
  "SliverToBoxAdapter",
  "SafeArea",
  "Divider",
  "Icon",
  "Image",
  "SvgPicture",
  "AutoSizeBuilder",
]);

const SHARED_COMPONENT_PATHS =
  /^lib\/widget\/(cw_|long_press|common_|base_)/;

/** module_core / cw_widget 等公共基础设施，不能当作业务页定位 */
const SHARED_INFRA_PATHS = [
  /^module_core\/lib\/module_base\//,
  /^module_core\/lib\/widget\//,
  /^module_core\/lib\/core\//,
  /^module_core\/lib\/test\//,
  /^cw_widget\/lib\//,
];

/** 第三方包内 lib/src/...（auto_size_text、lottie 等） */
const THIRD_PARTY_LIB_SRC = /^lib\/src\//;

const SYMBOL_BY_COMPONENT_FILE: Record<string, string[]> = {
  "lib/widget/cw_click_widget.dart": [
    ".gestureNoDouble(",
    ".gesture(",
    "CWClickWidget(",
  ],
  "lib/widget/long_press_popup_menu.dart": ["LongPressPopupMenu("],
  "lib/core/extension/widget_ex.dart": [
    ".gestureNoDouble(",
    ".gesture(",
    "CWClickWidget(",
  ],
};

const SYMBOL_BY_THIRD_PARTY_FILE: Record<string, string[]> = {
  "lib/src/auto_size_text.dart": ["AutoSizeText("],
  "lib/src/lottie_builder.dart": [
    "Lottie.asset(",
    "Lottie.network(",
    "Lottie(",
  ],
  "lib/src/lottie.dart": ["Lottie.asset(", "Lottie.network(", "Lottie("],
  "lib/src/vector_graphics.dart": ["VectorGraphic("],
};

function normalizeRebuildFile(file: string): string {
  let f = normalizeSourceFile(file);
  if (f.includes("widget_ex.dart")) return "lib/core/extension/widget_ex.dart";
  if (f.includes("cw_click_widget.dart")) return "lib/widget/cw_click_widget.dart";
  return f;
}

function prettifyBizClassName(cls: string): string {
  if (cls.startsWith("_") && cls.endsWith("State")) {
    return cls.slice(1, -5);
  }
  return cls;
}

function locationKey(file: string, line: number): string {
  return `${normalizeRebuildFile(file)}:${line}`;
}

function isSharedInfrastructureFile(
  file: string,
  projectRoot?: string
): boolean {
  let f = normalizeRebuildFile(file);
  if (projectRoot) {
    f = resolveFullProjectPath(projectRoot, f);
  }
  if (SHARED_INFRA_PATHS.some((re) => re.test(f))) return true;
  if (/^lib\/module_base\//.test(f)) return true;
  if (SHARED_COMPONENT_PATHS.test(f)) return true;
  return false;
}

function isPageLevelBiz(loc: BizLocation): boolean {
  const f = normalizeRebuildFile(loc.file);
  if (!f || isSharedInfrastructureFile(f)) return false;
  if (isFrameworkOrSdkFile(f)) return false;
  if (/^module_[^/]+\/lib\//.test(f) && !f.includes("module_core/")) return true;
  if (/_(page|view)\.dart$/i.test(f)) return true;
  return false;
}

function pickBestBizAncestor(ancestors: BizLocation[]): BizLocation | undefined {
  if (ancestors.length === 0) return undefined;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (isPageLevelBiz(ancestors[i])) return ancestors[i];
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const f = normalizeRebuildFile(ancestors[i].file);
    if (
      /^module_[^/]+\/lib\//.test(f) &&
      !f.includes("module_core/") &&
      !isPluginOrInternalRebuildFile(f)
    ) {
      return ancestors[i];
    }
  }
  return undefined;
}

function isDirectBusinessRebuild(
  file: string,
  widget: string,
  projectRoot?: string
): boolean {
  const f = normalizeRebuildFile(file);
  if (!f || isFrameworkOrSdkFile(f)) return false;
  if (isSharedInfrastructureFile(f, projectRoot)) return false;
  if (THIRD_PARTY_LIB_SRC.test(f)) return false;
  if (SHARED_COMPONENT_PATHS.test(f)) return false;
  if (f.includes("module_core/") || f.includes("cw_widget/")) return false;
  if (/^lib\/[\w]+_(page|view)\.dart$/i.test(f)) return true;
  if (/^lib\/(chance|market|rankings|search|kline|contract|asset|user|home)\//.test(f)) {
    return true;
  }
  if (
    !GENERIC_WIDGET_NAMES.has(widget) &&
    /^[A-Z][A-Za-z0-9]+$/.test(widget) &&
    widget.length > 4
  ) {
    return true;
  }
  return false;
}

function findEnclosingClass(source: string, targetLine: number): string | undefined {
  const lines = source.split("\n");
  const idx = Math.min(Math.max(targetLine, 1), lines.length) - 1;
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/class\s+([A-Za-z_]\w*)/);
    if (m) return m[1];
  }
  return undefined;
}

function resolveFullProjectPath(projectRoot: string, libPath: string): string {
  const normalized = normalizeSourceFile(libPath);
  if (!projectRoot || !normalized) return normalized;

  const direct = join(projectRoot, normalized);
  if (existsSync(direct)) return normalized;

  const fileName = normalized.split("/").pop() ?? normalized;
  try {
    const out = execSync(`rg --files -g "**/${fileName}"`, {
      cwd: projectRoot,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const candidates = out
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => p.endsWith(normalized) || p.endsWith(`/${normalized}`));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const moduleFirst = candidates.find((p) => /module_[^/]+\/lib\//.test(p));
      return moduleFirst ?? candidates[0];
    }
  } catch {
    // rg unavailable or no match
  }
  return normalized;
}

function isPluginOrInternalRebuildFile(file: string): boolean {
  const f = normalizeRebuildFile(file);
  if (!f || isFrameworkOrSdkFile(f)) return true;
  if (THIRD_PARTY_LIB_SRC.test(f)) return true;
  return /\/lottie|auto_size_text|easy_refresh|vector_graphics|extended_nested_scroll/i.test(
    f
  );
}

function isValidProjectBiz(loc: BizLocation, entryFile: string): boolean {
  const f = normalizeRebuildFile(loc.file);
  if (!f || isPluginOrInternalRebuildFile(f)) return false;
  if (isFrameworkOrSdkFile(f)) return false;
  if (isSharedInfrastructureFile(f)) return false;
  if (f.includes("module_core/lib/widget/cw_click_widget")) return false;
  if (f.includes("module_core/lib/core/extension/")) return false;
  if (
    normalizeRebuildFile(entryFile) === f &&
    isPluginOrInternalRebuildFile(f)
  ) {
    return false;
  }
  return true;
}

function resolveBizDisplayName(
  loc: BizLocation,
  projectRoot?: string
): BizLocation {
  let widget = prettifyBizClassName(loc.widget);
  if (
    GENERIC_WIDGET_NAMES.has(widget) &&
    projectRoot &&
    loc.file &&
    loc.line > 0
  ) {
    const abs = join(projectRoot, loc.file);
    if (existsSync(abs)) {
      const cls = findEnclosingClass(readFileSync(abs, "utf-8"), loc.line);
      if (cls) widget = prettifyBizClassName(cls);
    }
  }
  return { ...loc, widget };
}

function isBusinessModuleFile(file: string, projectRoot?: string): boolean {
  const f = projectRoot
    ? resolveFullProjectPath(projectRoot, file)
    : normalizeRebuildFile(file);
  if (!/^module_[^/]+\/lib\//.test(f)) return false;
  if (isSharedInfrastructureFile(f)) return false;
  return !isPluginOrInternalRebuildFile(f);
}

function tryResolveBizAtSource(
  entry: { widget: string; file: string; line: number },
  projectRoot?: string,
  source: RebuildEntry["bizSource"] = "direct"
): Partial<RebuildEntry> | undefined {
  if (!projectRoot || !isBusinessModuleFile(entry.file, projectRoot)) return undefined;
  const full = resolveFullProjectPath(projectRoot, entry.file);
  const resolved = resolveBizDisplayName(
    { widget: entry.widget, file: full, line: entry.line },
    projectRoot
  );
  if (!isValidProjectBiz(resolved, entry.file)) return undefined;
  return {
    bizWidget: resolved.widget,
    bizFile: resolved.file,
    bizLine: resolved.line,
    bizSource: source,
  };
}

function collectSameScreenHints(
  rebuilds: RebuildEntry[],
  projectRoot?: string
): BizLocation[] {
  const scored = new Map<string, BizLocation & { weight: number }>();
  for (const r of rebuilds) {
    if (r.bizSource !== "runtime" && r.bizSource !== "direct") continue;
    if (!r.bizWidget || !r.bizFile) continue;
    const loc = resolveBizDisplayName(
      { widget: r.bizWidget, file: r.bizFile, line: r.bizLine ?? 0 },
      projectRoot
    );
    if (!isValidProjectBiz(loc, r.file)) continue;
    const key = `${loc.widget}::${loc.file}`;
    const prev = scored.get(key);
    if (!prev || r.count > prev.weight) {
      scored.set(key, { ...loc, weight: r.count });
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.weight - a.weight)
    .map(({ weight: _, ...loc }) => loc);
}

function collectPageLevelScreenHints(
  rebuilds: RebuildEntry[],
  projectRoot?: string
): BizLocation[] {
  return collectSameScreenHints(rebuilds, projectRoot).filter((loc) =>
    isPageLevelBiz(loc)
  );
}

function inferLookupPatterns(file: string, widget: string): string[] {
  const f = normalizeRebuildFile(file);
  if (SYMBOL_BY_COMPONENT_FILE[f]) return SYMBOL_BY_COMPONENT_FILE[f];
  if (SYMBOL_BY_THIRD_PARTY_FILE[f]) return SYMBOL_BY_THIRD_PARTY_FILE[f];
  if (/lottie/i.test(f)) {
    return ["Lottie.asset(", "Lottie.network(", "Lottie("];
  }
  if (widget === "Lottie" || widget === "LottieBuilder") {
    return ["Lottie.asset(", "Lottie.network(", "Lottie("];
  }
  if (!GENERIC_WIDGET_NAMES.has(widget) && /^[A-Z]/.test(widget)) {
    return [`${widget}(`];
  }
  return [];
}

function pickBestStaticCaller(
  callers: BizLocation[],
  hintPaths: string[] = []
): BizLocation | undefined {
  if (callers.length === 0) return undefined;
  if (callers.length === 1) return callers[0];

  const hints = hintPaths.map((p) => normalizeSourceFile(p).toLowerCase());
  const refreshHint = hints.some(
    (h) =>
      h.includes("refresh") ||
      h.includes("space_indicator") ||
      h.includes("space_header") ||
      h.includes("easy_refresh")
  );
  const marketHint = hints.some(
    (h) => h.includes("market") || h.includes("chance")
  );

  const score = (c: BizLocation): number => {
    let s = 0;
    const f = c.file.toLowerCase();
    if (refreshHint && f.includes("refresh")) s += 20;
    if (marketHint && (f.includes("market") || f.includes("chance"))) s += 20;
    for (const h of hints) {
      const tail = h.split("/").slice(-2).join("/");
      if (tail && f.includes(tail)) s += 8;
    }
    return s;
  };

  return [...callers].sort((a, b) => score(b) - score(a))[0];
}

function findStaticBusinessCallers(
  projectRoot: string,
  patterns: string[],
  excludeSuffixes: string[] = []
): BizLocation[] {
  if (!projectRoot || patterns.length === 0) return [];

  const results: BizLocation[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (results.length >= 15) break;
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      const out = execSync(
        `rg -n --max-count 40 "${escaped}" module_*/lib --glob '!**/*.g.dart' --glob '!module_core/lib/widget/cw_click_widget.dart' --glob '!module_core/lib/widget/long_press_popup_menu.dart' --glob '!module_core/lib/core/extension/**'`,
        {
          cwd: projectRoot,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 6000,
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim();
      if (!out) continue;

      for (const row of out.split("\n")) {
        const m = row.match(/^([^:]+):(\d+):/);
        if (!m) continue;
        const relFile = m[1].replace(/\\/g, "/");
        if (excludeSuffixes.some((s) => relFile.endsWith(s))) continue;

        const line = Number(m[2]);
        const abs = join(projectRoot, relFile);
        if (!existsSync(abs)) continue;
        const source = readFileSync(abs, "utf-8");
        const cls = findEnclosingClass(source, line);
        if (!cls) continue;
        const bizWidget = prettifyBizClassName(cls);
        const dedupeKey = `${bizWidget}::${relFile}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        results.push({ widget: bizWidget, file: relFile, line });
        if (results.length >= 15) break;
      }
    } catch {
      // timeout or rg miss
    }
  }
  return results;
}

function buildRuntimeLocationMap(widgetTree: unknown): Map<string, BizLocation> {
  const map = new Map<string, BizLocation>();
  if (!widgetTree || typeof widgetTree !== "object") return map;

  const walk = (node: WidgetNode, projectAncestors: BizLocation[]) => {
    const loc = node.creationLocation;
    const isProject = node.createdByLocalProject === true;
    let ancestors = projectAncestors;

    if (isProject && loc?.file) {
      const biz: BizLocation = {
        widget: prettifyBizClassName(
          loc.name ??
            node.widgetRuntimeType ??
            node.description ??
            node.type ??
            "Unknown"
        ),
        file: normalizeSourceFile(loc.file),
        line: Number(loc.line ?? 0),
      };
      ancestors = [...projectAncestors, biz];
    }

    if (loc?.file && loc.line != null) {
      const key = locationKey(loc.file, loc.line);
      const best = pickBestBizAncestor(ancestors);
      if (best && !map.has(key)) {
        map.set(key, best);
      }
    }

    for (const child of node.children ?? []) {
      walk(child, ancestors);
    }
  };

  walk(widgetTree as WidgetNode, []);
  return map;
}

function formatBizLabel(loc: BizLocation, projectRoot?: string): string {
  const file = projectRoot
    ? resolveFullProjectPath(projectRoot, loc.file)
    : loc.file;
  return `${loc.widget} @ ${file}:${loc.line}`;
}

export function enrichRebuildsWithBusiness(
  rebuilds: RebuildEntry[],
  options: {
    projectRoot?: string;
    widgetTree?: unknown;
    hintPaths?: string[];
  } = {}
): RebuildEntry[] {
  const { projectRoot, widgetTree, hintPaths = [] } = options;
  const runtimeMap = buildRuntimeLocationMap(widgetTree);

  const mapped = rebuilds.map((entry) => {
    const file = normalizeRebuildFile(entry.file);
    const enriched: RebuildEntry = {
      widget: entry.widget,
      file,
      line: entry.line,
      count: entry.count,
      severity: entry.severity,
    };

    if (isDirectBusinessRebuild(file, entry.widget, projectRoot)) {
      const full = projectRoot ? resolveFullProjectPath(projectRoot, file) : file;
      enriched.bizWidget = prettifyBizClassName(entry.widget);
      enriched.bizFile = full;
      enriched.bizLine = entry.line;
      enriched.bizSource = "direct";
      return enriched;
    }

    const runtime = runtimeMap.get(locationKey(file, entry.line));
    if (runtime && isValidProjectBiz(runtime, file)) {
      const resolved = resolveBizDisplayName(runtime, projectRoot);
      enriched.bizWidget = resolved.widget;
      enriched.bizFile = projectRoot
        ? resolveFullProjectPath(projectRoot, resolved.file)
        : resolved.file;
      enriched.bizLine = resolved.line;
      enriched.bizSource = "runtime";
      return enriched;
    }

    if (isSharedInfrastructureFile(file, projectRoot)) {
      const patterns = inferLookupPatterns(file, entry.widget);
      if (patterns.length > 0 && projectRoot) {
        const callers = findStaticBusinessCallers(projectRoot, patterns, [
          "cw_click_widget.dart",
          "widget_ex.dart",
          file.split("/").pop() ?? "",
        ]);
        const top = pickBestStaticCaller(callers, hintPaths);
        if (top) {
          enriched.staticRefNote = `${top.widget} @ ${
            projectRoot
              ? resolveFullProjectPath(projectRoot, top.file)
              : top.file
          }:${top.line}`;
        }
      }
      return enriched;
    }

    const patterns = inferLookupPatterns(file, entry.widget);
    if (patterns.length > 0 && projectRoot) {
      const callers = findStaticBusinessCallers(projectRoot, patterns, [
        "cw_click_widget.dart",
        "widget_ex.dart",
        file.split("/").pop() ?? "",
      ]);
      const top = pickBestStaticCaller(callers, hintPaths);
      if (top && isPluginOrInternalRebuildFile(file)) {
        const refFile = projectRoot
          ? resolveFullProjectPath(projectRoot, top.file)
          : top.file;
        enriched.staticRefNote = `${top.widget} @ ${refFile}:${top.line}`;
      } else if (top) {
        enriched.bizWidget = top.widget;
        enriched.bizFile = projectRoot
          ? resolveFullProjectPath(projectRoot, top.file)
          : top.file;
        enriched.bizLine = top.line;
        enriched.bizSource = "static";
      }
    }

    const atSource = tryResolveBizAtSource(enriched, projectRoot, "direct");
    if (atSource) Object.assign(enriched, atSource);

    return enriched;
  });

  const pageScreenHints = collectPageLevelScreenHints(mapped, projectRoot);
  const moduleScreenHints = collectSameScreenHints(mapped, projectRoot);
  const dominantScreen = pageScreenHints[0] ?? moduleScreenHints[0];

  return mapped.map((entry) => {
    if (
      entry.bizSource === "runtime" ||
      entry.bizSource === "direct" ||
      (entry.bizSource === "static" && !isPluginOrInternalRebuildFile(entry.file))
    ) {
      if (
        isSharedInfrastructureFile(entry.file, projectRoot) &&
        !entry.bizWidget &&
        dominantScreen
      ) {
        return {
          ...entry,
          bizWidget: dominantScreen.widget,
          bizFile: projectRoot
            ? resolveFullProjectPath(projectRoot, dominantScreen.file)
            : dominantScreen.file,
          bizLine: dominantScreen.line,
          bizSource: "inferred" as const,
        };
      }
      return entry;
    }
    if (dominantScreen && isPluginOrInternalRebuildFile(entry.file)) {
      return {
        ...entry,
        bizWidget: dominantScreen.widget,
        bizFile: projectRoot
          ? resolveFullProjectPath(projectRoot, dominantScreen.file)
          : dominantScreen.file,
        bizLine: dominantScreen.line,
        bizSource: "inferred" as const,
        staticRefNote: entry.staticRefNote,
      };
    }
    if (entry.staticRefNote && !entry.bizWidget) {
      return entry;
    }
    if (
      !entry.bizWidget &&
      dominantScreen &&
      isSharedInfrastructureFile(entry.file, projectRoot)
    ) {
      return {
        ...entry,
        bizWidget: dominantScreen.widget,
        bizFile: projectRoot
          ? resolveFullProjectPath(projectRoot, dominantScreen.file)
          : dominantScreen.file,
        bizLine: dominantScreen.line,
        bizSource: "inferred" as const,
      };
    }
    return entry;
  });
}

export function formatRebuildLocationCell(
  entry: RebuildEntry,
  projectRoot?: string
): { biz: string; component: string } {
  const componentFile = projectRoot
    ? resolveFullProjectPath(projectRoot, entry.file)
    : entry.file;
  const component = `${entry.widget} @ ${componentFile}:${entry.line}`;

  if (entry.bizWidget && entry.bizFile) {
    const bizFile = projectRoot
      ? resolveFullProjectPath(projectRoot, entry.bizFile)
      : entry.bizFile;
    const suffix =
      entry.bizSource === "inferred"
        ? "（同屏推测，非插件内精确行）"
        : entry.bizSource === "static"
          ? "（代码库引用，非当前屏）"
          : entry.bizSource === "runtime"
            ? "（当前屏上级）"
            : "";
    let biz = `${entry.bizWidget} @ ${bizFile}:${entry.bizLine ?? 0}${suffix}`;
    if (entry.staticRefNote) {
      biz += `；代码库参考 ${entry.staticRefNote}`;
    }
    const componentIsInfra = isSharedInfrastructureFile(entry.file, projectRoot);
    return {
      biz,
      component:
        entry.bizSource === "direct" && !componentIsInfra
          ? "-"
          : component,
    };
  }

  if (entry.staticRefNote) {
    return {
      biz: `未定位当前屏；代码库参考 ${entry.staticRefNote}`,
      component,
    };
  }

  if (isPluginOrInternalRebuildFile(entry.file)) {
    return {
      biz: "未定位当前屏（插件/三方组件内部）",
      component,
    };
  }

  return { biz: "-", component };
}
