import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";

const execAsync = promisify(exec);

interface DiscoveredApp {
  vmServiceUri: string;
  pid: number;
  platform?: string;
}

async function findFlutterProcesses(): Promise<DiscoveredApp[]> {
  const apps: DiscoveredApp[] = [];

  try {
    const { stdout } = await execAsync(
      "ps aux | grep -E 'dart|flutter' | grep -v grep",
      { timeout: 5000 }
    );

    const vmServicePattern =
      /http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_\-+=]+\//g;
    const pidPattern = /^\S+\s+(\d+)/;

    for (const line of stdout.split("\n")) {
      const uris = line.match(vmServicePattern);
      const pidMatch = line.match(pidPattern);
      if (uris && pidMatch) {
        for (const uri of uris) {
          apps.push({
            vmServiceUri: uri,
            pid: parseInt(pidMatch[1], 10),
          });
        }
      }
    }
  } catch {
    // ps not available or no processes
  }

  if (apps.length === 0) {
    try {
      const { stdout } = await execAsync(
        "cat /tmp/flutter_tools.*/vmservice.json 2>/dev/null || " +
          "cat $TMPDIR/flutter_tools.*/vmservice.json 2>/dev/null || " +
          "echo ''",
        { timeout: 3000 }
      );

      if (stdout.trim()) {
        for (const line of stdout.trim().split("\n")) {
          try {
            const data = JSON.parse(line);
            if (data.uri) {
              apps.push({
                vmServiceUri: data.uri,
                pid: data.pid ?? 0,
                platform: data.platform,
              });
            }
          } catch {
            // not valid JSON
          }
        }
      }
    } catch {
      // temp files not available
    }
  }

  if (apps.length === 0) {
    const commonPorts = [
      ...Array.from({ length: 100 }, (_, i) => 50000 + i),
      ...Array.from({ length: 50 }, (_, i) => 8080 + i),
      ...Array.from({ length: 50 }, (_, i) => 9100 + i),
    ];

    const scanPort = async (port: number): Promise<string | null> => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(300),
        });
        const text = await response.text();
        if (text.includes("Dart") || text.includes("vm_service")) {
          return `http://127.0.0.1:${port}/`;
        }
      } catch {
        // port not open or not Dart
      }
      return null;
    };

    const batchSize = 30;
    for (let i = 0; i < commonPorts.length; i += batchSize) {
      const batch = commonPorts.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(scanPort));
      for (const uri of results) {
        if (uri) {
          apps.push({ vmServiceUri: uri, pid: 0 });
        }
      }
      if (apps.length > 0) break;
    }
  }

  const seen = new Set<string>();
  return apps.filter((app) => {
    if (seen.has(app.vmServiceUri)) return false;
    seen.add(app.vmServiceUri);
    return true;
  });
}

export function registerDiscoverTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  server.tool(
    "discover_apps",
    "Automatically discover running Flutter apps on this machine. Scans for Dart VM Service instances so you don't have to manually copy the URI. If an app is found, you can connect to it directly.",
    {
      autoConnect: z
        .boolean()
        .default(true)
        .describe(
          "Automatically connect to the first discovered app (default: true)"
        ),
    },
    async ({ autoConnect }) => {
      try {
        const apps = await findFlutterProcesses();

        if (apps.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No running Flutter apps found.\n\nMake sure your app is running with:\n  flutter run\n  flutter run --profile\n\nThe VM Service URI is printed in the terminal when the app starts.",
              },
            ],
          };
        }

        if (autoConnect && !client.connected) {
          try {
            const vmInfo = await client.connect(apps[0].vmServiceUri);
            const mainIsolate = vmInfo.isolates.find(
              (i) => !i.isSystemIsolate
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `Found ${apps.length} Flutter app(s). Auto-connected to:`,
                    "",
                    `  URI: ${apps[0].vmServiceUri}`,
                    `  PID: ${apps[0].pid || "unknown"}`,
                    `  VM: ${vmInfo.version}`,
                    `  OS: ${vmInfo.operatingSystem}`,
                    `  Isolate: ${mainIsolate?.name ?? "unknown"}`,
                    "",
                    apps.length > 1
                      ? `Other apps found:\n${apps
                          .slice(1)
                          .map(
                            (a) => `  • ${a.vmServiceUri} (PID: ${a.pid})`
                          )
                          .join("\n")}\n\nUse the \`connect\` tool to switch to a different app.`
                      : "Ready to inspect.",
                  ].join("\n"),
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Found app at ${apps[0].vmServiceUri} but failed to connect: ${err instanceof Error ? err.message : String(err)}\n\nTry connecting manually with the \`connect\` tool.`,
                },
              ],
              isError: true,
            };
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Found ${apps.length} running Flutter app(s):`,
                "",
                ...apps.map(
                  (a, i) =>
                    `  ${i + 1}. ${a.vmServiceUri} (PID: ${a.pid || "unknown"}${a.platform ? `, ${a.platform}` : ""})`
                ),
                "",
                "Use the `connect` tool with one of these URIs.",
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to discover apps: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
