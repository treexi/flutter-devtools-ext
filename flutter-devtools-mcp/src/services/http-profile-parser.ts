import type { NetworkRequestRecord } from "./network-capture-service.js";

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 将 ext.dart.io.getHttpProfile 的 requests 转为 NetworkRequestRecord */
export function parseHttpProfileRequests(
  requests: Array<Record<string, unknown>> | undefined,
  captureStartMicros?: number
): NetworkRequestRecord[] {
  if (!requests?.length) return [];

  const out: NetworkRequestRecord[] = [];
  for (const req of requests) {
    const uri = str(req.uri);
    if (!uri || !uri.startsWith("http")) continue;

    const startMicros = num(req.startTime);
    if (
      captureStartMicros != null &&
      startMicros != null &&
      startMicros < captureStartMicros
    ) {
      continue;
    }

    const id = str(req.id) ?? `${uri}_${startMicros ?? out.length}`;
    const endMicros = num(req.endTime);
    const response = req.response as Record<string, unknown> | undefined;
    const responseStartMicros = num(response?.startTime);
    const responseEndMicros = num(response?.endTime) ?? endMicros;

    const startMs =
      startMicros != null ? Math.floor(startMicros / 1000) : Date.now();
    const endMs =
      responseEndMicros != null
        ? Math.floor(responseEndMicros / 1000)
        : endMicros != null
          ? Math.floor(endMicros / 1000)
          : undefined;

    let responseSize = num(response?.contentLength);
    if (responseSize == null) {
      const headers = response?.headers as Record<string, unknown> | undefined;
      responseSize = num(headers?.["content-length"] ?? headers?.contentLength);
    }

    const requestBlock = req.request as Record<string, unknown> | undefined;
    const statusCode =
      num(response?.statusCode) ??
      num(response?.status) ??
      num(requestBlock?.statusCode);

    const error =
      str(response?.error as string) ??
      str(requestBlock?.error as string) ??
      (response?.error != null ? String(response.error) : undefined);

    let postResponseMs: number | undefined;
    if (responseEndMicros != null && endMicros != null && endMicros >= responseEndMicros) {
      postResponseMs = Math.round((endMicros - responseEndMicros) / 1000 * 10) / 10;
    }

    let bodyDownloadMs: number | undefined;
    if (responseStartMicros != null && responseEndMicros != null && responseEndMicros >= responseStartMicros) {
      bodyDownloadMs = Math.round((responseEndMicros - responseStartMicros) / 1000 * 10) / 10;
    }

    out.push({
      id,
      method: (str(req.method) ?? "GET").toUpperCase(),
      uri,
      startTime: startMs,
      endTime: endMs,
      statusCode,
      responseSize,
      error,
      responseStartMicros,
      responseEndMicros,
      postResponseMs,
      bodyDownloadMs,
    });
  }

  return out;
}
