import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient, AllocationProfile } from "../services/vm-service-client.js";

interface Snapshot {
  name: string;
  timestamp: number;
  memory: {
    heapUsage: number;
    heapCapacity: number;
    externalUsage: number;
    topClasses: Array<{
      name: string;
      bytes: number;
      instances: number;
    }>;
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(abs) / Math.log(k));
  return `${sign}${(abs / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

function pctChange(before: number, after: number): string {
  if (before === 0) return after > 0 ? "+∞%" : "0%";
  const pct = ((after - before) / before) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function registerSnapshotDiffTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  const snapshots = new Map<string, Snapshot>();

  async function takeSnapshot(
    name: string,
    gc: boolean
  ): Promise<Snapshot> {
    const profile = await client.getAllocationProfile(undefined, gc);

    const validMembers = profile.members.filter((m) => m.class?.name);
    const sorted = [...validMembers]
      .sort((a, b) => b.bytesCurrent - a.bytesCurrent)
      .filter((m) => m.bytesCurrent > 0)
      .slice(0, 50);

    return {
      name,
      timestamp: Date.now(),
      memory: {
        heapUsage: profile.memoryUsage.heapUsage,
        heapCapacity: profile.memoryUsage.heapCapacity,
        externalUsage: profile.memoryUsage.externalUsage,
        topClasses: sorted.map((m) => ({
          name: m.class.name,
          bytes: m.bytesCurrent,
          instances: m.instancesCurrent,
        })),
      },
    };
  }

  server.tool(
    "save_snapshot",
    "Save a named memory snapshot for later comparison. Take a snapshot before making a code change, then take another after to see the impact. Use compare_snapshots to see the diff.",
    {
      name: z
        .string()
        .describe(
          'A name for this snapshot (e.g., "before-fix", "after-optimization")'
        ),
      forceGC: z
        .boolean()
        .default(true)
        .describe("Force garbage collection before snapshot (default: true)"),
    },
    async ({ name, forceGC }) => {
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
        const snapshot = await takeSnapshot(name, forceGC);
        snapshots.set(name, snapshot);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `✅ Snapshot "${name}" saved.`,
                "",
                `  Heap: ${formatBytes(snapshot.memory.heapUsage)} / ${formatBytes(snapshot.memory.heapCapacity)}`,
                `  Classes tracked: ${snapshot.memory.topClasses.length}`,
                `  Time: ${new Date(snapshot.timestamp).toLocaleTimeString()}`,
                "",
                `Saved snapshots: ${Array.from(snapshots.keys()).join(", ")}`,
                "",
                'Take another snapshot after your change, then use `compare_snapshots` to see the diff.',
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to save snapshot: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "compare_snapshots",
    "Compare two previously saved memory snapshots to see what changed. Shows heap usage diff, which classes grew or shrank, new allocations, and freed memory. Perfect for validating that a fix actually reduced memory usage.",
    {
      before: z
        .string()
        .describe('Name of the "before" snapshot'),
      after: z
        .string()
        .describe('Name of the "after" snapshot'),
    },
    async ({ before, after }) => {
      const snap1 = snapshots.get(before);
      const snap2 = snapshots.get(after);

      if (!snap1) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Snapshot "${before}" not found. Available: ${Array.from(snapshots.keys()).join(", ") || "none"}`,
            },
          ],
          isError: true,
        };
      }

      if (!snap2) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Snapshot "${after}" not found. Available: ${Array.from(snapshots.keys()).join(", ") || "none"}`,
            },
          ],
          isError: true,
        };
      }

      const heapDiff =
        snap2.memory.heapUsage - snap1.memory.heapUsage;
      const capacityDiff =
        snap2.memory.heapCapacity - snap1.memory.heapCapacity;

      const beforeMap = new Map(
        snap1.memory.topClasses.map((c) => [c.name, c])
      );
      const afterMap = new Map(
        snap2.memory.topClasses.map((c) => [c.name, c])
      );

      const allClassNames = new Set([
        ...beforeMap.keys(),
        ...afterMap.keys(),
      ]);

      const diffs: Array<{
        name: string;
        bytesBefore: number;
        bytesAfter: number;
        bytesDiff: number;
        instancesBefore: number;
        instancesAfter: number;
        instancesDiff: number;
      }> = [];

      for (const name of allClassNames) {
        const b = beforeMap.get(name);
        const a = afterMap.get(name);
        diffs.push({
          name,
          bytesBefore: b?.bytes ?? 0,
          bytesAfter: a?.bytes ?? 0,
          bytesDiff: (a?.bytes ?? 0) - (b?.bytes ?? 0),
          instancesBefore: b?.instances ?? 0,
          instancesAfter: a?.instances ?? 0,
          instancesDiff: (a?.instances ?? 0) - (b?.instances ?? 0),
        });
      }

      const grew = diffs
        .filter((d) => d.bytesDiff > 0)
        .sort((a, b) => b.bytesDiff - a.bytesDiff);
      const shrank = diffs
        .filter((d) => d.bytesDiff < 0)
        .sort((a, b) => a.bytesDiff - b.bytesDiff);

      const heapIcon = heapDiff <= 0 ? "🟢" : heapDiff > 10_000_000 ? "🔴" : "🟡";

      const output = [
        "═══════════════════════════════════════════════════════════",
        "  SNAPSHOT COMPARISON",
        `  "${before}" → "${after}"`,
        "═══════════════════════════════════════════════════════════",
        "",
        "📊 HEAP OVERVIEW",
        "───────────────────────────────────────────────────────────",
        `${heapIcon} Heap usage: ${formatBytes(snap1.memory.heapUsage)} → ${formatBytes(snap2.memory.heapUsage)} (${heapDiff <= 0 ? "" : "+"}${formatBytes(heapDiff)}, ${pctChange(snap1.memory.heapUsage, snap2.memory.heapUsage)})`,
        `  Capacity:   ${formatBytes(snap1.memory.heapCapacity)} → ${formatBytes(snap2.memory.heapCapacity)} (${capacityDiff <= 0 ? "" : "+"}${formatBytes(capacityDiff)})`,
        `  Time between snapshots: ${((snap2.timestamp - snap1.timestamp) / 1000).toFixed(1)}s`,
        "",
      ];

      if (grew.length > 0) {
        output.push("📈 GREW (top 10)");
        output.push(
          "───────────────────────────────────────────────────────────"
        );
        for (const d of grew.slice(0, 10)) {
          const instDiff =
            d.instancesDiff > 0
              ? `+${d.instancesDiff.toLocaleString()}`
              : d.instancesDiff.toLocaleString();
          output.push(
            `  🔺 +${formatBytes(d.bytesDiff).padStart(10)} | ${instDiff.padStart(8)} inst | ${d.name}`
          );
        }
        output.push("");
      }

      if (shrank.length > 0) {
        output.push("📉 SHRANK (top 10)");
        output.push(
          "───────────────────────────────────────────────────────────"
        );
        for (const d of shrank.slice(0, 10)) {
          const instDiff =
            d.instancesDiff > 0
              ? `+${d.instancesDiff.toLocaleString()}`
              : d.instancesDiff.toLocaleString();
          output.push(
            `  🔻 ${formatBytes(d.bytesDiff).padStart(11)} | ${instDiff.padStart(8)} inst | ${d.name}`
          );
        }
        output.push("");
      }

      output.push("💡 VERDICT");
      output.push(
        "───────────────────────────────────────────────────────────"
      );

      if (heapDiff < -1_000_000) {
        output.push(
          `✅ Memory improved by ${formatBytes(Math.abs(heapDiff))} (${pctChange(snap1.memory.heapUsage, snap2.memory.heapUsage)}). Nice work!`
        );
      } else if (heapDiff > 1_000_000) {
        output.push(
          `⚠️ Memory increased by ${formatBytes(heapDiff)} (${pctChange(snap1.memory.heapUsage, snap2.memory.heapUsage)}). Check the classes that grew above.`
        );
      } else {
        output.push(
          "➡️ No significant change in memory usage between snapshots."
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: output.join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "list_snapshots",
    "List all saved memory snapshots available for comparison.",
    {},
    async () => {
      if (snapshots.size === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No snapshots saved yet. Use `save_snapshot` to create one.",
            },
          ],
        };
      }

      const lines = ["Saved snapshots:", ""];
      for (const [name, snap] of snapshots) {
        lines.push(
          `  • "${name}" — ${formatBytes(snap.memory.heapUsage)} heap, ${new Date(snap.timestamp).toLocaleTimeString()}`
        );
      }

      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
        ],
      };
    }
  );
}
