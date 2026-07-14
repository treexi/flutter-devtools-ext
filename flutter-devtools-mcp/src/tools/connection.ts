import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";

export function registerConnectionTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  server.tool(
    "connect",
    "Connect to a running Flutter app via its VM Service URI. The URI is printed when you run `flutter run` (e.g., http://127.0.0.1:50000/xxxxx=/). You must connect before using any other tool.",
    {
      vmServiceUri: z
        .string()
        .describe(
          "The VM Service URI of the running Flutter app (e.g., http://127.0.0.1:50000/AbCdEf=/)"
        ),
    },
    async ({ vmServiceUri }) => {
      try {
        const vmInfo = await client.connect(vmServiceUri);
        const mainIsolate = vmInfo.isolates.find((i) => !i.isSystemIsolate);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "connected",
                  vm: {
                    name: vmInfo.name,
                    version: vmInfo.version,
                    os: vmInfo.operatingSystem,
                    targetCPU: vmInfo.targetCPU,
                    pid: vmInfo.pid,
                  },
                  mainIsolate: mainIsolate
                    ? {
                        id: mainIsolate.id,
                        name: mainIsolate.name,
                      }
                    : null,
                  isolateCount: vmInfo.isolates.length,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "disconnect",
    "Disconnect from the currently connected Flutter app.",
    {},
    async () => {
      if (!client.connected) {
        return {
          content: [
            { type: "text" as const, text: "Not connected to any app." },
          ],
        };
      }

      await client.disconnect();
      return {
        content: [
          {
            type: "text" as const,
            text: "Disconnected from Flutter app.",
          },
        ],
      };
    }
  );

  server.tool(
    "get_app_info",
    "Get detailed information about the connected Flutter app including VM info, isolates, and available extensions.",
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

      try {
        const vmInfo = await client.getVM();
        const isolateDetails = await client.getIsolate();
        const isolate = isolateDetails as {
          rootLib?: { uri: string };
          libraries?: Array<{ uri: string }>;
          extensionRPCs?: string[];
          pauseEvent?: { kind: string };
        };

        const fps = await client.getDisplayRefreshRate();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  vm: {
                    name: vmInfo.name,
                    version: vmInfo.version,
                    os: vmInfo.operatingSystem,
                    hostCPU: vmInfo.hostCPU,
                    targetCPU: vmInfo.targetCPU,
                    architectureBits: vmInfo.architectureBits,
                    pid: vmInfo.pid,
                  },
                  app: {
                    rootLibrary: isolate.rootLib?.uri ?? "unknown",
                    libraryCount: isolate.libraries?.length ?? 0,
                    pauseState: isolate.pauseEvent?.kind ?? "unknown",
                    displayRefreshRate: fps,
                  },
                  flutterExtensions: (isolate.extensionRPCs ?? []).filter(
                    (e: string) => e.startsWith("ext.flutter.")
                  ),
                  isolates: vmInfo.isolates.map((i) => ({
                    id: i.id,
                    name: i.name,
                    isSystem: i.isSystemIsolate,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get app info: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
