import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

export function registerMemoryTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  server.tool(
    "get_memory_snapshot",
    "Get a memory allocation profile of the running Flutter app. Shows heap usage, top memory-consuming classes, and potential leak indicators.",
    {
      forceGC: z
        .boolean()
        .default(false)
        .describe(
          "Force garbage collection before taking the snapshot (gives a more accurate view of live objects)"
        ),
      topN: z
        .number()
        .min(5)
        .max(100)
        .default(20)
        .describe("Number of top memory-consuming classes to show"),
    },
    async ({ forceGC, topN }) => {
      if (!client.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not connected. Use the `connect` tool first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const profile = await client.getAllocationProfile(undefined, forceGC);

        const heapUsage = profile.memoryUsage.heapUsage;
        const heapCapacity = profile.memoryUsage.heapCapacity;
        const externalUsage = profile.memoryUsage.externalUsage;
        const heapUtilization = (heapUsage / heapCapacity) * 100;

        const validMembers = profile.members.filter(
          (m) => m.class?.name
        );

        const sortedBySize = [...validMembers]
          .sort((a, b) => b.bytesCurrent - a.bytesCurrent)
          .filter((m) => m.bytesCurrent > 0);

        const sortedByInstances = [...validMembers]
          .sort((a, b) => b.instancesCurrent - a.instancesCurrent)
          .filter((m) => m.instancesCurrent > 0);

        const output = [
          "═══════════════════════════════════════════════════════════",
          "  MEMORY SNAPSHOT",
          "═══════════════════════════════════════════════════════════",
          "",
          "📊 HEAP OVERVIEW",
          "───────────────────────────────────────────────────────────",
          `Heap used:     ${formatBytes(heapUsage)}`,
          `Heap capacity: ${formatBytes(heapCapacity)}`,
          `Utilization:   ${heapUtilization.toFixed(1)}%`,
          `External:      ${formatBytes(externalUsage)}`,
          `Total:         ${formatBytes(heapUsage + externalUsage)}`,
          forceGC ? "(Snapshot taken after forced GC)" : "",
          "",
          `📦 TOP ${topN} CLASSES BY MEMORY`,
          "───────────────────────────────────────────────────────────",
        ];

        for (const member of sortedBySize.slice(0, topN)) {
          const pct = ((member.bytesCurrent / heapUsage) * 100).toFixed(1);
          output.push(
            `${formatBytes(member.bytesCurrent).padStart(12)} (${pct}%) | ${member.instancesCurrent.toLocaleString().padStart(8)} instances | ${member.class.name}`
          );
        }

        output.push("");
        output.push(`📈 TOP 10 CLASSES BY INSTANCE COUNT`);
        output.push(
          "───────────────────────────────────────────────────────────"
        );

        for (const member of sortedByInstances.slice(0, 10)) {
          output.push(
            `${member.instancesCurrent.toLocaleString().padStart(12)} instances | ${formatBytes(member.bytesCurrent).padStart(12)} | ${member.class.name}`
          );
        }

        const vmInternalClasses = new Set([
          "_OneByteString", "_TwoByteString", "String",
          "_List", "_GrowableList", "_ImmutableList",
          "_Mint", "_Double", "bool", "Null", "int", "double",
          "Class", "ForwardingCorpse", "FreeListElement",
          "TypeParameter", "UnlinkedCall", "ICData",
          "Field", "Function", "Code", "Instructions",
          "ObjectPool", "PcDescriptors", "CodeSourceMap",
          "CompressedStackMaps", "Type", "_Type", "LibraryPrefix",
          "_FunctionType", "Namespace", "Library",
          "TypeArguments", "ClosureData", "SubtypeTestCache",
          "SingleTargetCache", "MegamorphicCache",
          "WeakProperty", "WeakReference", "FinalizerEntry",
          "_WeakProperty", "_WeakReference",
          "KernelProgramInfo", "Script", "Bytecode",
          "_Int8List", "_Uint8List", "_Uint16List", "_Uint32List",
          "_Int32List", "_Float32List", "_Float64List",
          "_ExternalOneByteString", "Array", "GrowableObjectArray",
          "Context", "ContextScope", "RegExp", "_RegExp",
          "LocalVarDescriptors", "ExceptionHandlers",
          "ParameterTypeCheck", "ApiErrorClass", "LanguageError",
          "Bool", "Sentinel", "FfiTrampolineData",
        ]);

        const isVmInternal = (name: string) =>
          vmInternalClasses.has(name) ||
          name.startsWith("_") && name.length < 20 && !name.includes("State") && !name.includes("Controller");

        const appClasses = sortedByInstances.filter(
          (m) =>
            m.instancesCurrent > 0 &&
            m.bytesCurrent > 0 &&
            !isVmInternal(m.class.name)
        );

        if (appClasses.length > 0) {
          output.push("");
          output.push("🏗️ APP & FRAMEWORK CLASSES");
          output.push(
            "───────────────────────────────────────────────────────────"
          );
          for (const cls of appClasses.slice(0, 20)) {
            output.push(
              `${cls.instancesCurrent.toLocaleString().padStart(12)} instances | ${formatBytes(cls.bytesCurrent).padStart(12)} | ${cls.class.name}`
            );
          }
        }

        const suspiciousClasses = appClasses.filter(
          (m) => m.instancesCurrent > 500
        );

        if (suspiciousClasses.length > 0) {
          output.push("");
          output.push("⚠️ POTENTIAL CONCERNS");
          output.push(
            "───────────────────────────────────────────────────────────"
          );
          for (const cls of suspiciousClasses.slice(0, 5)) {
            output.push(
              `• ${cls.class.name}: ${cls.instancesCurrent.toLocaleString()} instances (${formatBytes(cls.bytesCurrent)}) - check for leaks or excessive allocations`
            );
          }
        }

        if (heapUtilization > 85) {
          output.push("");
          output.push(
            "🔴 WARNING: Heap utilization above 85%. The app may be at risk of OOM. Consider reducing memory footprint."
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: output.filter(Boolean).join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get memory snapshot: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
