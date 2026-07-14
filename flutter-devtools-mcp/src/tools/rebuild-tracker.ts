import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";
import { mergeLocationMap } from "../services/rebuild-tracker-service.js";

interface RebuildEntry {
  widgetName: string;
  file: string;
  line: number;
  rebuildCount: number;
}

export function registerRebuildTrackerTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  let tracking = false;
  let rebuildCounts = new Map<number, number>();
  let locationMap: Record<
    string,
    { file: string; line: number; column: number; name: string }
  > = {};
  let trackingStartTime = 0;

  const rebuildListener = (event: any) => {
    if (event?.extensionKind === "Flutter.RebuiltWidgets") {
      const data = event.extensionData as
        | {
            locations?: unknown;
            newLocations?: unknown;
            events?: number[];
          }
        | undefined;
      if (data?.locations) mergeLocationMap(locationMap, data.locations);
      if (data?.newLocations)
        mergeLocationMap(locationMap, data.newLocations);
      if (data?.events && Array.isArray(data.events)) {
        for (let i = 0; i < data.events.length; i += 2) {
          const locationId = data.events[i];
          const count = data.events[i + 1];
          rebuildCounts.set(
            locationId,
            (rebuildCounts.get(locationId) ?? 0) + count
          );
        }
      }
    }
  };

  server.tool(
    "start_tracking_rebuilds",
    "Start tracking which widgets are rebuilding and how often. After starting, interact with the app, then call stop_tracking_rebuilds to see exactly which widgets rebuilt, how many times, and where they are in your code. This is the most effective way to find unnecessary rebuilds.",
    {},
    async () => {
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

      if (tracking) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Already tracking rebuilds. Call stop_tracking_rebuilds first.",
            },
          ],
          isError: true,
        };
      }

      try {
        rebuildCounts = new Map();
        locationMap = {};

        try {
          mergeLocationMap(locationMap, await client.getWidgetLocationMap());
        } catch {
          // Location map may not be available yet
        }

        client.on("stream:Extension", rebuildListener);
        await client.startTrackingRebuilds();
        tracking = true;
        trackingStartTime = Date.now();

        return {
          content: [
            {
              type: "text" as const,
              text: "✅ Rebuild tracking started. Interact with the app now (scroll, tap, navigate between screens), then call `stop_tracking_rebuilds` to see which widgets rebuilt and how many times.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to start rebuild tracking: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "stop_tracking_rebuilds",
    "Stop tracking widget rebuilds and get a detailed report showing exactly which widgets rebuilt, how many times, and their source file locations. Sorted by rebuild count to highlight the most problematic widgets.",
    {
      topN: z
        .number()
        .min(5)
        .max(100)
        .default(30)
        .describe("Number of top rebuilding widgets to show"),
    },
    async ({ topN }) => {
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

      if (!tracking) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not tracking rebuilds. Call start_tracking_rebuilds first.",
            },
          ],
          isError: true,
        };
      }

      try {
        await client.stopTrackingRebuilds();
        client.off("stream:Extension", rebuildListener);
        tracking = false;

        const durationMs = Date.now() - trackingStartTime;

        try {
          mergeLocationMap(locationMap, await client.getWidgetLocationMap());
        } catch {
          // Best effort
        }

        const entries: RebuildEntry[] = [];
        let totalRebuilds = 0;

        for (const [locationId, count] of rebuildCounts) {
          totalRebuilds += count;
          const loc = locationMap[String(locationId)];
          if (loc) {
            const file = loc.file
              .replace(/^file:\/\//, "")
              .split("/lib/")
              .pop() ?? loc.file.split("/").pop() ?? loc.file;
            entries.push({
              widgetName: loc.name,
              file,
              line: loc.line,
              rebuildCount: count,
            });
          } else {
            entries.push({
              widgetName: `Unknown (location ${locationId})`,
              file: "unknown",
              line: 0,
              rebuildCount: count,
            });
          }
        }

        entries.sort((a, b) => b.rebuildCount - a.rebuildCount);

        const uniqueWidgets = entries.length;
        const durationSec = (durationMs / 1000).toFixed(1);

        const output = [
          "═══════════════════════════════════════════════════════════",
          "  WIDGET REBUILD REPORT",
          "═══════════════════════════════════════════════════════════",
          "",
          "📊 SUMMARY",
          "───────────────────────────────────────────────────────────",
          `Tracked for ${durationSec}s`,
          `Total rebuilds: ${totalRebuilds.toLocaleString()}`,
          `Unique widgets rebuilt: ${uniqueWidgets}`,
          `Average rebuilds per widget: ${uniqueWidgets > 0 ? (totalRebuilds / uniqueWidgets).toFixed(1) : "0"}`,
          "",
        ];

        if (entries.length === 0) {
          output.push(
            "No rebuilds captured. Make sure you interacted with the app while tracking."
          );
        } else {
          output.push(
            `🔥 TOP ${Math.min(topN, entries.length)} REBUILDING WIDGETS`
          );
          output.push(
            "───────────────────────────────────────────────────────────"
          );

          for (const entry of entries.slice(0, topN)) {
            const severity =
              entry.rebuildCount > 100
                ? "🔴"
                : entry.rebuildCount > 30
                  ? "🟠"
                  : entry.rebuildCount > 10
                    ? "🟡"
                    : "🟢";
            output.push(
              `${severity} ${entry.rebuildCount.toLocaleString().padStart(6)}x | ${entry.widgetName} [${entry.file}:${entry.line}]`
            );
          }

          const excessiveRebuilds = entries.filter(
            (e) => e.rebuildCount > 50
          );
          if (excessiveRebuilds.length > 0) {
            output.push("");
            output.push("💡 RECOMMENDATIONS");
            output.push(
              "───────────────────────────────────────────────────────────"
            );

            for (const entry of excessiveRebuilds.slice(0, 5)) {
              output.push(
                `• ${entry.widgetName} rebuilt ${entry.rebuildCount}x [${entry.file}:${entry.line}]`
              );

              if (entry.rebuildCount > 100) {
                output.push(
                  `  → This widget is rebuilding excessively. Check if it depends on a`
                );
                output.push(
                  `    Provider/InheritedWidget that changes too frequently. Consider`
                );
                output.push(
                  `    using context.select() instead of context.watch() or adding`
                );
                output.push(`    a const constructor.`);
              } else {
                output.push(
                  `  → Consider wrapping in a const constructor or extracting into`
                );
                output.push(
                  `    a separate widget to limit rebuild scope.`
                );
              }
            }
          }

          if (excessiveRebuilds.length === 0) {
            output.push("");
            output.push(
              "✅ No excessive rebuilds detected. Widget rebuild counts look healthy."
            );
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: output.join("\n"),
            },
          ],
        };
      } catch (error) {
        tracking = false;
        client.off("stream:Extension", rebuildListener);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to stop rebuild tracking: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
