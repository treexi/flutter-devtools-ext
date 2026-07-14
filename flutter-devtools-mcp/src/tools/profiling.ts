import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";
import { Profiler } from "../services/profiler.js";

export function registerProfilingTools(
  server: McpServer,
  client: FlutterVmServiceClient,
  profiler: Profiler
) {
  server.tool(
    "start_profiling",
    "Start a performance profiling session. After starting, interact with the app (scroll, tap, navigate) to generate activity, then call stop_profiling to get the analysis. The app should be running in profile mode (`flutter run --profile`) for accurate results.",
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

      if (profiler.isActive) {
        return {
          content: [
            {
              type: "text" as const,
              text: "A profiling session is already active. Call stop_profiling first.",
            },
          ],
          isError: true,
        };
      }

      try {
        await profiler.start();
        return {
          content: [
            {
              type: "text" as const,
              text: "✅ Profiling started. Interact with the app now (scroll, tap, navigate), then call `stop_profiling` to get the analysis.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to start profiling: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "stop_profiling",
    "Stop the current profiling session and get a detailed performance analysis including frame timing, jank detection, CPU hotspots, build/layout/paint phase analysis, and actionable recommendations.",
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

      if (!profiler.isActive) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active profiling session. Call start_profiling first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await profiler.stop();

        const output = [
          "═══════════════════════════════════════════════════════════",
          "  FLUTTER PERFORMANCE ANALYSIS REPORT",
          "═══════════════════════════════════════════════════════════",
          "",
          "📊 SUMMARY",
          "───────────────────────────────────────────────────────────",
          ...result.summary,
          "",
          "📈 FRAME ANALYSIS",
          "───────────────────────────────────────────────────────────",
          `Total frames: ${result.frameAnalysis.totalFrames}`,
          `Average frame time: ${result.frameAnalysis.averageFrameTimeMs.toFixed(2)}ms`,
          `P90 frame time: ${result.frameAnalysis.p90FrameTimeMs.toFixed(2)}ms`,
          `P99 frame time: ${result.frameAnalysis.p99FrameTimeMs.toFixed(2)}ms`,
          `Max frame time: ${result.frameAnalysis.maxFrameTimeMs.toFixed(2)}ms`,
          `Jank frames: ${result.frameAnalysis.jankFrames} (${result.frameAnalysis.jankPercentage.toFixed(1)}%)`,
          `Target: ${result.frameAnalysis.targetFrameTimeMs.toFixed(1)}ms (${Math.round(1000 / result.frameAnalysis.targetFrameTimeMs)}fps)`,
          "",
          "🔧 PHASE BREAKDOWN",
          "───────────────────────────────────────────────────────────",
          `Build:  avg ${result.buildPhaseAnalysis.avgBuildTimeMs.toFixed(2)}ms | max ${result.buildPhaseAnalysis.maxBuildTimeMs.toFixed(2)}ms | ${result.buildPhaseAnalysis.buildCount} calls`,
          `Layout: avg ${result.layoutPhaseAnalysis.avgLayoutTimeMs.toFixed(2)}ms | max ${result.layoutPhaseAnalysis.maxLayoutTimeMs.toFixed(2)}ms | ${result.layoutPhaseAnalysis.layoutCount} calls`,
          `Paint:  avg ${result.paintPhaseAnalysis.avgPaintTimeMs.toFixed(2)}ms | max ${result.paintPhaseAnalysis.maxPaintTimeMs.toFixed(2)}ms | ${result.paintPhaseAnalysis.paintCount} calls`,
          "",
        ];

        if (result.cpuHotspots.length > 0) {
          output.push("🔥 CPU HOTSPOTS");
          output.push(
            "───────────────────────────────────────────────────────────"
          );
          for (const h of result.cpuHotspots.slice(0, 10)) {
            const severityIcon =
              h.severity === "critical"
                ? "🔴"
                : h.severity === "high"
                  ? "🟠"
                  : h.severity === "medium"
                    ? "🟡"
                    : "🟢";
            output.push(
              `${severityIcon} ${h.name} [${h.severity.toUpperCase()}]`
            );
            output.push(
              `   Total: ${h.totalDurationMs.toFixed(1)}ms | Avg: ${h.avgDurationMs.toFixed(1)}ms | Max: ${h.maxDurationMs.toFixed(1)}ms | Calls: ${h.callCount}`
            );
          }
          output.push("");
        }

        output.push("💡 RECOMMENDATIONS");
        output.push(
          "───────────────────────────────────────────────────────────"
        );
        for (const rec of result.recommendations) {
          output.push(`• ${rec}`);
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
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to stop profiling: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
