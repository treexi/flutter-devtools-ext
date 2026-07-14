import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";

export function registerDebugActionTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  server.tool(
    "hot_reload",
    "Trigger a hot reload on the running Flutter app. Injects updated source code without restarting the app or losing state.",
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
        await client.hotReload();
        return {
          content: [
            {
              type: "text" as const,
              text: "✅ Hot reload triggered successfully.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to hot reload: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "hot_restart",
    "Trigger a hot restart on the running Flutter app. Restarts the app from scratch but is faster than a full rebuild.",
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
        await client.hotRestart();
        return {
          content: [
            {
              type: "text" as const,
              text: "✅ Hot restart triggered successfully.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to hot restart: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "take_screenshot",
    "Capture a screenshot of the running Flutter app. Returns the screenshot as a base64-encoded PNG image.",
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
        const result = (await client.screenshot()) as {
          screenshot?: string;
          type?: string;
        };

        if (result?.screenshot) {
          return {
            content: [
              {
                type: "image" as const,
                data: result.screenshot,
                mimeType: "image/png" as const,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: "Screenshot captured but no image data was returned. This may not be supported in the current Flutter configuration.",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "toggle_debug_paint",
    "Toggle the debug paint overlay on the Flutter app. Shows widget borders, padding, and alignment guides.",
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
        const result = (await client.toggleDebugPaint()) as {
          enabled?: boolean;
        };
        const state = result?.enabled ? "ON" : "OFF";
        return {
          content: [
            {
              type: "text" as const,
              text: `Debug paint overlay toggled ${state}.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to toggle debug paint: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "evaluate_expression",
    "Evaluate a Dart expression in the context of the running Flutter app. Useful for inspecting runtime values, checking state, or running diagnostics.",
    {
      expression: z
        .string()
        .describe(
          "The Dart expression to evaluate (e.g., 'MediaQuery.of(context).size', 'MyClass.instance.someValue')"
        ),
    },
    async ({ expression }) => {
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
        const result = (await client.evaluate(expression)) as {
          kind?: string;
          valueAsString?: string;
          class?: { name: string };
          type?: string;
        };

        if (result.kind === "Error" || result.type === "@Error") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Evaluation error: ${result.valueAsString ?? JSON.stringify(result)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  expression,
                  result: result.valueAsString ?? "void",
                  type: result.class?.name ?? result.kind ?? "unknown",
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
              text: `Failed to evaluate expression: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
