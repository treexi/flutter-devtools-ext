#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FlutterVmServiceClient } from "./services/vm-service-client.js";
import { Profiler } from "./services/profiler.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerWidgetTreeTools } from "./tools/widget-tree.js";
import { registerProfilingTools } from "./tools/profiling.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerDebugActionTools } from "./tools/debug-actions.js";
import { registerRebuildTrackerTools } from "./tools/rebuild-tracker.js";
import { registerDiscoverTools } from "./tools/discover.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerSnapshotDiffTools } from "./tools/snapshot-diff.js";
import { RebuildTrackerService } from "./services/rebuild-tracker-service.js";
import { NetworkCaptureService } from "./services/network-capture-service.js";
import { CpuProfilerService } from "./services/cpu-profiler-service.js";
import { PerformanceSession } from "./services/performance-session.js";
import { registerPerformanceSessionTools } from "./tools/performance-session.js";

const server = new McpServer({
  name: "flutter-devtools-mcp",
  version: "0.3.0",
});

const vmClient = new FlutterVmServiceClient();
const profiler = new Profiler(vmClient);
const rebuildTracker = new RebuildTrackerService(vmClient);
const networkCapture = new NetworkCaptureService(vmClient);
const cpuProfiler = new CpuProfilerService(vmClient);
const performanceSession = new PerformanceSession(
  vmClient,
  profiler,
  rebuildTracker,
  networkCapture,
  cpuProfiler
);

registerDiscoverTools(server, vmClient);
registerConnectionTools(server, vmClient);
registerWidgetTreeTools(server, vmClient);
registerProfilingTools(server, vmClient, profiler);
registerMemoryTools(server, vmClient);
registerRebuildTrackerTools(server, vmClient);
registerNetworkTools(server, vmClient);
registerSnapshotDiffTools(server, vmClient);
registerDebugActionTools(server, vmClient);
registerPerformanceSessionTools(server, performanceSession);

vmClient.on("error", (err) => {
  console.error("[flutter-devtools-mcp] VM Service error:", err);
});

vmClient.on("disconnected", () => {
  console.error(
    "[flutter-devtools-mcp] Disconnected from Flutter app VM Service"
  );
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[flutter-devtools-mcp] Server started on stdio transport");
}

main().catch((err) => {
  console.error("[flutter-devtools-mcp] Fatal error:", err);
  process.exit(1);
});
