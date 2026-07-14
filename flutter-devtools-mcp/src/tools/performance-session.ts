import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PerformanceSession, formatSessionSummary } from "../services/performance-session.js";
import { PERFORMANCE_SESSIONS_DIR } from "../services/session-types.js";

export function registerPerformanceSessionTools(
  server: McpServer,
  session: PerformanceSession
) {
  server.tool(
    "collect_performance_session",
    `采集指定时长的 Flutter 性能数据并返回结构化 JSON，供 AI 结合源码给出优化方案。

重要：durationSec 仅为「录制窗口」（默认还会 +2s 预热）。工具返回前还需收尾（Timeline/CPU/报告），Android 真机总耗时常为 录制+30s～+120s，期间会输出 [perf] 进度。

推荐话术：用户说「连接 Flutter App，开始采集性能数据 30s」时：
1. 先 discover_apps / connect（adb 转发口需用真实 VM URI，非 302 端口）
2. 调用本工具并告知用户「录制 30s，请保持 App 前台；收尾可能再需 1～2 分钟」
3. 工具返回后读取 filesToInspect，按 hintsForAnalysis 输出 P0/P1/P2

采集项：帧率/jank、Widget 重建（含行号）、CPU Top 函数、网络；内存默认关闭（enableMemory=true 开启）。`,
    {
      scenario: z
        .string()
        .default("manual-session")
        .describe("场景标识，如 home-list-scroll"),
      durationSec: z
        .number()
        .min(5)
        .max(120)
        .default(30)
        .describe(
          "录制窗口（秒）；不含收尾分析时间。总耗时见返回 progressLog / wallClockSec"
        ),
      enableNetwork: z.boolean().default(true),
      enableCpuProfile: z.boolean().default(true),
      enableMemory: z
        .boolean()
        .default(false)
        .describe(
          "是否调用 getAllocationProfile(gc:true)；默认 false 以缩短 Android 收尾"
        ),
      topN: z.number().min(5).max(50).default(15),
      saveToFile: z
        .boolean()
        .default(false)
        .describe(`是否保存 JSON/AI 报告到 Flutter 工程下的 ${PERFORMANCE_SESSIONS_DIR}/`),
      outputDir: z
        .string()
        .optional()
        .describe(
          `覆盖默认输出目录；未指定时使用 {projectRoot}/${PERFORMANCE_SESSIONS_DIR}`
        ),
      generateAiReport: z
        .boolean()
        .default(true)
        .describe("是否生成 P0/P1/P2 规则引擎分析报告"),
      projectRoot: z
        .string()
        .optional()
        .describe(
          "Flutter 工程根目录（读取源码 + 默认将报告保存到该目录下的 performance-sessions/）"
        ),
    },
    async ({
      scenario,
      durationSec,
      enableNetwork,
      enableCpuProfile,
      enableMemory,
      topN,
      saveToFile,
      outputDir,
      generateAiReport,
      projectRoot,
    }) => {
      try {
        const { result, savedPath } = await session.collect({
          scenario,
          durationSec,
          enableNetwork,
          enableCpuProfile,
          enableMemory,
          topN,
          saveToFile,
          outputDir,
          generateAiReport,
          projectRoot,
        });

        const summary = formatSessionSummary(result);
        const json = JSON.stringify(result, null, 2);

        const rec = result.recordingWindowSec ?? durationSec;
        const wall = result.wallClockSec ?? result.durationSec;
        const text = [
          `✅ 性能采集完成（录制 ${rec}s，总耗时 ${wall}s，场景：${scenario}）`,
          "",
          "── 采集进度 ──",
          ...(result.progressLog?.map((p) => `- ${p}`) ?? ["- （无进度日志）"]),
          "",
          "── 中文摘要 ──",
          summary,
        ];

        if (result.aiAnalysis) {
          text.push("", "── AI 优化方案（规则引擎）──", result.aiAnalysis);
        }

        text.push("", "── PerformanceSessionResult JSON ──", json);

        if (savedPath) {
          text.push("", `已保存: ${savedPath}`);
          if (result.aiAnalysis) {
            text.push(`AI 分析: ${savedPath.replace(/\.json$/, ".ai.md")}`);
          }
        }

        if (result.durationSec < 5) {
          text.push("", "⚠️ 采集时长过短，数据可能不足。");
        }

        return {
          content: [{ type: "text" as const, text: text.join("\n") }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `采集失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
