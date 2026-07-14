/** VM / 引擎内部 CPU 符号，不可当作业务 lib/ 方法 */
import type { PerformanceSessionResult } from "./session-types.js";

const VM_CPU_SYMBOL_PATTERNS: Array<{ test: RegExp; label: string }> = [
  { test: /^Dart_InvokeClosure$/i, label: "闭包调用（VM，非业务函数）" },
  {
    test: /^Dart_(HandleMessage|RunLoop)$/i,
    label: "Isolate 消息循环（VM）",
  },
  { test: /^DartIsolate::/i, label: "Isolate 调度（VM）" },
  { test: /^Concurrent(Mark|Sweep|Copy)$/i, label: "GC 并发阶段（VM）" },
  { test: /^(Scavenge|MarkCompact|MarkSweep|Sweep)$/i, label: "GC 阶段（VM）" },
  { test: /^Dart_/i, label: "Dart VM 内部（非业务函数）" },
  { test: /::/i, label: "VM 原生符号（非业务函数）" },
  { test: /^\[Native\]/i, label: "Native 代码（VM）" },
];

const VM_CPU_NAME_EXACT = new Set([
  "ConcurrentMark",
  "ConcurrentSweep",
  "ConcurrentCopy",
  "Scavenge",
  "MarkCompact",
  "IdleTime",
  "NotifyIdle",
]);

export function isVmInternalCpuSymbol(name?: string): boolean {
  if (!name) return false;
  if (VM_CPU_NAME_EXACT.has(name)) return true;
  return VM_CPU_SYMBOL_PATTERNS.some((p) => p.test.test(name));
}

/** profile 采样常把 VM 符号误归到 lib/main.dart */
export function isMisattributedVmCpuEntry(
  name?: string,
  file?: string
): boolean {
  if (!isVmInternalCpuSymbol(name)) return false;
  const f = (file ?? "").toLowerCase();
  return (
    f === "lib/main.dart" ||
    f.endsWith("/main.dart") ||
    f.includes("lib/main.dart")
  );
}

export function humanizeVmCpuSymbol(name: string): string {
  for (const { test, label } of VM_CPU_SYMBOL_PATTERNS) {
    if (test.test(name)) return label;
  }
  if (VM_CPU_NAME_EXACT.has(name)) return `${name}（VM）`;
  return `${name}（VM，非业务函数）`;
}

export function isBusinessCpuSymbol(name?: string, file?: string): boolean {
  if (!name) return false;
  if (isVmInternalCpuSymbol(name)) return false;
  if (isMisattributedVmCpuEntry(name, file)) return false;
  return true;
}

/** 旧 session JSON 或采集结果：剔除误入业务表的 VM 符号，补齐 vmTopFunctions */
export function sanitizeSessionCpuTops(
  result: PerformanceSessionResult
): PerformanceSessionResult {
  const removedFromProject = result.projectTopFunctions.filter(
    (f) => !isBusinessCpuSymbol(f.name, f.file)
  );
  const projectTopFunctions = result.projectTopFunctions.filter((f) =>
    isBusinessCpuSymbol(f.name, f.file)
  );

  let vmTopFunctions = result.vmTopFunctions;
  if (!vmTopFunctions?.length) {
    const seen = new Set<string>();
    const vmCandidates = [...result.topFunctions, ...removedFromProject].filter(
      (f) => {
        const key = `${f.name}::${f.file}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return (
          isVmInternalCpuSymbol(f.name) ||
          isMisattributedVmCpuEntry(f.name, f.file)
        );
      }
    );
    vmTopFunctions = vmCandidates
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 5)
      .map((f) => ({
        name: humanizeVmCpuSymbol(f.name),
        rawName: f.name,
        file: f.file,
        selfMs: f.selfMs,
        pct: f.pct,
        severity: f.severity,
      }));
  }

  return {
    ...result,
    projectTopFunctions,
    vmTopFunctions,
  };
}
