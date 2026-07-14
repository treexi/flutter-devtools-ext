import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FlutterVmServiceClient } from "../services/vm-service-client.js";

interface WidgetNode {
  description?: string;
  type?: string;
  widgetRuntimeType?: string;
  children?: WidgetNode[];
  valueId?: string;
  createdByLocalProject?: boolean;
  hasChildren?: boolean;
  creationLocation?: {
    file?: string;
    line?: number;
    column?: number;
    name?: string;
  };
  properties?: Array<{
    name: string;
    description?: string;
    value?: unknown;
  }>;
}

interface FlatWidget {
  type: string;
  depth: number;
  id?: string;
  isProjectWidget: boolean;
  childCount: number;
  sourceFile?: string;
  sourceLine?: number;
  properties?: Array<{ name: string; value: string }>;
}

function flattenWidgetTree(
  node: WidgetNode,
  depth: number = 0,
  maxDepth: number = 15,
  projectOnly: boolean = false
): FlatWidget[] {
  if (depth > maxDepth) return [];

  const isProjectWidget = node.createdByLocalProject ?? false;

  if (projectOnly && !isProjectWidget && depth > 2) {
    const childResults: FlatWidget[] = [];
    for (const child of node.children ?? []) {
      childResults.push(
        ...flattenWidgetTree(child, depth, maxDepth, projectOnly)
      );
    }
    return childResults;
  }

  const widgetName =
    node.creationLocation?.name ??
    node.widgetRuntimeType ??
    node.description ??
    node.type ??
    "Unknown";

  const flat: FlatWidget = {
    type: widgetName,
    depth,
    id: node.valueId,
    isProjectWidget,
    childCount: node.children?.length ?? 0,
  };

  if (isProjectWidget && node.creationLocation?.file) {
    const file = node.creationLocation.file.replace(/^file:\/\//, "");
    const shortFile = file.split("/lib/").pop() ?? file.split("/").pop() ?? file;
    flat.sourceFile = shortFile;
    flat.sourceLine = node.creationLocation.line;
  }

  if (node.properties && node.properties.length > 0) {
    flat.properties = node.properties
      .filter((p) => p.description && p.description !== "null")
      .slice(0, 10)
      .map((p) => ({
        name: p.name,
        value: String(p.description ?? p.value ?? ""),
      }));
  }

  const results = [flat];

  for (const child of node.children ?? []) {
    results.push(
      ...flattenWidgetTree(child, depth + 1, maxDepth, projectOnly)
    );
  }

  return results;
}

function formatTreeAsText(widgets: FlatWidget[]): string {
  return widgets
    .map((w) => {
      const indent = "  ".repeat(w.depth);
      const projectMarker = w.isProjectWidget ? " ★" : "";
      const childInfo = w.childCount > 0 ? ` (${w.childCount} children)` : "";
      const sourceInfo =
        w.sourceFile ? ` [${w.sourceFile}:${w.sourceLine}]` : "";
      let line = `${indent}${w.type}${projectMarker}${childInfo}${sourceInfo}`;

      if (w.properties && w.properties.length > 0) {
        const props = w.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
        line += ` [${props}]`;
      }

      return line;
    })
    .join("\n");
}

export function registerWidgetTreeTools(
  server: McpServer,
  client: FlutterVmServiceClient
) {
  server.tool(
    "get_widget_tree",
    "Get the current widget tree of the running Flutter app. Returns a structured representation of all widgets on screen. Widgets marked with ★ are from your project code (not framework widgets).",
    {
      maxDepth: z
        .number()
        .min(1)
        .max(50)
        .default(15)
        .describe("Maximum depth of the widget tree to return (default: 15)"),
      projectOnly: z
        .boolean()
        .default(false)
        .describe(
          "If true, only show widgets created by the project (skip framework internals)"
        ),
    },
    async ({ maxDepth, projectOnly }) => {
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
        const tree = (await client.getWidgetTree()) as WidgetNode;
        const flattened = flattenWidgetTree(tree, 0, maxDepth, projectOnly);
        const text = formatTreeAsText(flattened);

        const stats = {
          totalWidgets: flattened.length,
          projectWidgets: flattened.filter((w) => w.isProjectWidget).length,
          maxDepthReached: Math.max(...flattened.map((w) => w.depth)),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Widget Tree (${stats.totalWidgets} widgets, ${stats.projectWidgets} from project, depth: ${stats.maxDepthReached})\n${"─".repeat(60)}\n${text}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get widget tree: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "inspect_widget",
    "Get detailed information about a specific widget by its ID (obtained from get_widget_tree). Returns render details, constraints, size, and state.",
    {
      widgetId: z
        .string()
        .describe("The widget ID from the widget tree (valueId field)"),
    },
    async ({ widgetId }) => {
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
        const details = await client.getWidgetDetails(widgetId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to inspect widget: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
