import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";

interface HttpRequest {
  id: string;
  method: string;
  uri: string;
  startTime: number;
  endTime?: number;
  statusCode?: number;
  requestSize?: number;
  responseSize?: number;
  contentType?: string;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function registerNetworkTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  let capturing = false;
  let requests = new Map<string, HttpRequest>();
  let captureStartTime = 0;

  const httpListener = (event: any) => {
    if (!event) return;

    const kind = event.extensionKind ?? event.kind;
    const data = event.extensionData ?? event;

    if (kind === "dart:io.httpClient.request.start" || kind === "HttpClientRequest") {
      const id = data?.id?.toString() ?? data?.isolateId ?? `req_${Date.now()}`;
      requests.set(id, {
        id,
        method: data?.method ?? "GET",
        uri: data?.uri ?? data?.url ?? "unknown",
        startTime: Date.now(),
        requestSize: data?.contentLength ?? data?.requestSize,
      });
    }

    if (kind === "dart:io.httpClient.request.finish" || kind === "HttpClientResponse") {
      const id = data?.id?.toString() ?? data?.isolateId;
      const req = id ? requests.get(id) : undefined;
      if (req) {
        req.endTime = Date.now();
        req.statusCode = data?.statusCode ?? data?.status;
        req.responseSize =
          data?.contentLength ?? data?.responseSize ?? data?.compressionState?.length;
        req.contentType = data?.contentType ?? data?.headers?.["content-type"];
      }
    }

    if (kind === "dart:io.httpClient.request.error") {
      const id = data?.id?.toString();
      const req = id ? requests.get(id) : undefined;
      if (req) {
        req.endTime = Date.now();
        req.error = data?.error ?? data?.message ?? "Unknown error";
      }
    }

    if (
      kind === "Extension" &&
      data?.extensionKind?.includes("http")
    ) {
      const extData = data.extensionData;
      if (extData?.method && extData?.uri) {
        const id = extData.id?.toString() ?? `ext_${Date.now()}`;
        const existing = requests.get(id);
        if (!existing) {
          requests.set(id, {
            id,
            method: extData.method,
            uri: extData.uri,
            startTime: extData.startTime ?? Date.now(),
            endTime: extData.endTime,
            statusCode: extData.statusCode ?? extData.status,
            responseSize: extData.responseSize ?? extData.contentLength,
            contentType: extData.contentType,
          });
        }
      }
    }
  };

  server.tool(
    "start_network_capture",
    "Start capturing HTTP network traffic from the running Flutter app. After starting, use the app to trigger API calls, then call stop_network_capture to see all requests with timing, status codes, and sizes.",
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

      if (capturing) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Already capturing network traffic. Call stop_network_capture first.",
            },
          ],
          isError: true,
        };
      }

      requests = new Map();
      captureStartTime = Date.now();
      capturing = true;

      client.on("stream:Extension", httpListener);
      client.on("stream:Logging", httpListener);
      client.on("event", httpListener);

      try {
        await client
          .callServiceExtension("ext.dart.io.httpEnableTimelineLogging", undefined, {
            enabled: true,
          })
          .catch(() => {});
      } catch {
        // Extension may not be available
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "✅ Network capture started. Use the app to trigger API calls, then call `stop_network_capture` to see the results.",
          },
        ],
      };
    }
  );

  server.tool(
    "stop_network_capture",
    "Stop capturing network traffic and get a detailed report of all HTTP requests including method, URL, status code, response time, and payload size.",
    {
      sortBy: z
        .enum(["time", "duration", "size"])
        .default("time")
        .describe(
          "Sort requests by: time (chronological), duration (slowest first), size (largest first)"
        ),
    },
    async ({ sortBy }) => {
      if (!capturing) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not capturing network traffic. Call start_network_capture first.",
            },
          ],
          isError: true,
        };
      }

      capturing = false;
      client.off("stream:Extension", httpListener);
      client.off("stream:Logging", httpListener);
      client.off("event", httpListener);

      try {
        await client
          .callServiceExtension("ext.dart.io.httpEnableTimelineLogging", undefined, {
            enabled: false,
          })
          .catch(() => {});
      } catch {
        // Best effort
      }

      const durationMs = Date.now() - captureStartTime;
      const allRequests = Array.from(requests.values());

      if (allRequests.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Captured for ${(durationMs / 1000).toFixed(1)}s — no HTTP requests detected.`,
                "",
                "This can happen if:",
                "• The app didn't make any network calls during capture",
                "• HTTP timeline logging is not supported in this Flutter version",
                "• The app uses a custom HTTP client that doesn't go through dart:io",
                "",
                "Try making the app load data (pull to refresh, navigate to a new screen).",
              ].join("\n"),
            },
          ],
        };
      }

      const sorted = [...allRequests];
      switch (sortBy) {
        case "duration":
          sorted.sort((a, b) => {
            const durA = a.endTime ? a.endTime - a.startTime : 0;
            const durB = b.endTime ? b.endTime - b.startTime : 0;
            return durB - durA;
          });
          break;
        case "size":
          sorted.sort(
            (a, b) => (b.responseSize ?? 0) - (a.responseSize ?? 0)
          );
          break;
        default:
          sorted.sort((a, b) => a.startTime - b.startTime);
      }

      const completedRequests = sorted.filter((r) => r.endTime);
      const failedRequests = sorted.filter((r) => r.error);
      const pendingRequests = sorted.filter(
        (r) => !r.endTime && !r.error
      );

      const totalSize = sorted.reduce(
        (sum, r) => sum + (r.responseSize ?? 0),
        0
      );
      const durations = completedRequests.map(
        (r) => r.endTime! - r.startTime
      );
      const avgDuration =
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0;
      const maxDuration =
        durations.length > 0 ? Math.max(...durations) : 0;

      const output = [
        "═══════════════════════════════════════════════════════════",
        "  NETWORK TRAFFIC REPORT",
        "═══════════════════════════════════════════════════════════",
        "",
        "📊 SUMMARY",
        "───────────────────────────────────────────────────────────",
        `Captured for ${(durationMs / 1000).toFixed(1)}s`,
        `Total requests: ${allRequests.length}`,
        `Completed: ${completedRequests.length} | Failed: ${failedRequests.length} | Pending: ${pendingRequests.length}`,
        `Total response size: ${formatBytes(totalSize)}`,
        `Average response time: ${formatDuration(avgDuration)}`,
        `Slowest request: ${formatDuration(maxDuration)}`,
        "",
        "📡 REQUESTS",
        "───────────────────────────────────────────────────────────",
      ];

      for (const req of sorted) {
        const duration = req.endTime
          ? formatDuration(req.endTime - req.startTime)
          : "pending...";
        const status = req.error
          ? `❌ ${req.error}`
          : req.statusCode
            ? req.statusCode >= 400
              ? `🔴 ${req.statusCode}`
              : req.statusCode >= 300
                ? `🟡 ${req.statusCode}`
                : `🟢 ${req.statusCode}`
            : "⏳";
        const size = req.responseSize
          ? formatBytes(req.responseSize)
          : "-";

        output.push(
          `${status} ${req.method.padEnd(6)} ${duration.padStart(8)} | ${size.padStart(8)} | ${req.uri}`
        );
      }

      const slowRequests = completedRequests.filter(
        (r) => r.endTime! - r.startTime > 2000
      );
      const largeResponses = completedRequests.filter(
        (r) => (r.responseSize ?? 0) > 500000
      );
      const errors = failedRequests;

      if (
        slowRequests.length > 0 ||
        largeResponses.length > 0 ||
        errors.length > 0
      ) {
        output.push("");
        output.push("⚠️ CONCERNS");
        output.push(
          "───────────────────────────────────────────────────────────"
        );

        for (const req of slowRequests.slice(0, 3)) {
          const dur = formatDuration(req.endTime! - req.startTime);
          output.push(
            `• SLOW: ${req.method} ${req.uri} took ${dur}`
          );
        }

        for (const req of largeResponses.slice(0, 3)) {
          output.push(
            `• LARGE: ${req.method} ${req.uri} returned ${formatBytes(req.responseSize!)}`
          );
        }

        for (const req of errors.slice(0, 3)) {
          output.push(
            `• ERROR: ${req.method} ${req.uri} — ${req.error}`
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
    }
  );
}
