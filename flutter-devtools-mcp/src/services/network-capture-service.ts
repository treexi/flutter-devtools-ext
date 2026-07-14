import { FlutterVmServiceClient } from "./vm-service-client.js";
import { parseHttpProfileRequests } from "./http-profile-parser.js";

export interface NetworkRequestRecord {
  id: string;
  method: string;
  uri: string;
  startTime: number;
  endTime?: number;
  statusCode?: number;
  responseSize?: number;
  error?: string;
  /** 响应头到达（µs） */
  responseStartMicros?: number;
  /** 响应体接收完成（µs） */
  responseEndMicros?: number;
  /** 响应收完 → 请求结束（ms），含主 isolate transform/解析 */
  postResponseMs?: number;
  /** 响应体下载耗时（ms） */
  bodyDownloadMs?: number;
}

export interface NetworkCaptureSummary {
  total: number;
  errors: number;
  slow: Array<{ method: string; url: string; ms: number; status?: number }>;
  requests: NetworkRequestRecord[];
}

export class NetworkCaptureService {
  private client: FlutterVmServiceClient;
  private capturing = false;
  private requests = new Map<string, NetworkRequestRecord>();
  /** VM 时间戳（µs），用于 getHttpProfile(updatedSince) 过滤录制窗口 */
  private captureStartMicros = 0;

  private httpListener = (event: unknown) => {
    if (!event) return;

    const e = event as {
      extensionKind?: string;
      kind?: string;
      extensionData?: Record<string, unknown>;
    };
    const kind = e.extensionKind ?? e.kind;
    const data = (e.extensionData ?? e) as Record<string, unknown>;

    if (
      kind === "dart:io.httpClient.request.start" ||
      kind === "HttpClientRequest"
    ) {
      const id =
        data?.id?.toString() ??
        data?.isolateId?.toString() ??
        `req_${Date.now()}`;
      this.requests.set(id, {
        id,
        method: (data?.method as string) ?? "GET",
        uri: (data?.uri as string) ?? (data?.url as string) ?? "unknown",
        startTime: Date.now(),
      });
    }

    if (
      kind === "dart:io.httpClient.request.finish" ||
      kind === "HttpClientResponse"
    ) {
      const id = data?.id?.toString() ?? data?.isolateId?.toString();
      const req = id ? this.requests.get(id) : undefined;
      if (req) {
        req.endTime = Date.now();
        req.statusCode =
          (data?.statusCode as number) ?? (data?.status as number);
        req.responseSize =
          (data?.contentLength as number) ??
          (data?.responseSize as number);
      }
    }

    if (kind === "dart:io.httpClient.request.error") {
      const id = data?.id?.toString();
      const req = id ? this.requests.get(id) : undefined;
      if (req) {
        req.endTime = Date.now();
        req.error =
          (data?.error as string) ??
          (data?.message as string) ??
          "Unknown error";
      }
    }
  };

  constructor(client: FlutterVmServiceClient) {
    this.client = client;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  async start(): Promise<void> {
    if (this.capturing) throw new Error("Network capture already active");

    this.requests = new Map();
    this.capturing = true;
    try {
      this.captureStartMicros = await this.client.getVMTimelineMicros();
    } catch {
      this.captureStartMicros = Date.now() * 1000;
    }

    this.client.on("stream:Extension", this.httpListener);
    this.client.on("stream:Logging", this.httpListener);
    this.client.on("stream:Timeline", this.httpListener);
    this.client.on("event", this.httpListener);

    const isolateId = this.client.mainIsolateId ?? undefined;
    await this.client
      .callServiceExtension(
        "ext.dart.io.httpEnableTimelineLogging",
        isolateId,
        { enabled: true }
      )
      .catch(() => {});
  }

  async stop(options?: {
    traceEvents?: Array<{ name?: string; ph?: string; args?: Record<string, unknown> }>;
  }): Promise<NetworkCaptureSummary> {
    if (!this.capturing) throw new Error("Network capture not active");

    this.capturing = false;
    this.client.off("stream:Extension", this.httpListener);
    this.client.off("stream:Logging", this.httpListener);
    this.client.off("stream:Timeline", this.httpListener);
    this.client.off("event", this.httpListener);

    await this.client
      .callServiceExtension(
        "ext.dart.io.httpEnableTimelineLogging",
        this.client.mainIsolateId ?? undefined,
        { enabled: false }
      )
      .catch(() => {});

    // 主路径：DevTools Network 同源的 HttpProfile（含完整 uri/method）
    try {
      const profile = await this.client.getHttpProfile(this.captureStartMicros);
      const fromProfile = parseHttpProfileRequests(
        profile.requests,
        this.captureStartMicros
      );
      for (const req of fromProfile) {
        this.requests.set(req.id, req);
      }
    } catch {
      // profile 不可用时回退 Timeline
    }

    if (options?.traceEvents?.length) {
      this.ingestTimelineEvents(options.traceEvents);
    } else {
      try {
        const timeline = await this.client.getTimeline();
        this.ingestTimelineEvents(timeline.traceEvents ?? []);
      } catch {
        // timeline fallback optional
      }
    }

    const all = Array.from(this.requests.values()).filter(
      (r) => r.uri.startsWith("http")
    );
    const errors = all.filter((r) => r.error).length;
    const slow = all
      .filter((r) => r.endTime && r.endTime - r.startTime > 2000)
      .map((r) => ({
        method: r.method,
        url: r.uri,
        ms: r.endTime! - r.startTime,
        status: r.statusCode,
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10);

    return { total: all.length, errors, slow, requests: all };
  }

  private ingestTimelineEvents(
    events: Array<{ name?: string; ph?: string; args?: Record<string, unknown> }>
  ): void {
    for (const event of events) {
      const name = event.name ?? "";
      const args = event.args ?? {};
      const nestedRequest = args.request as Record<string, unknown> | undefined;
      const uri =
        (args.uri as string) ??
        (args.url as string) ??
        (nestedRequest?.uri as string) ??
        (nestedRequest?.url as string);

      if (typeof uri === "string" && uri.startsWith("http")) {
        const id =
          args.id?.toString() ??
          args.requestId?.toString() ??
          `${uri}_${args.startTime ?? event.ph ?? "t"}`;
        if (!this.requests.has(id)) {
          this.requests.set(id, {
            id,
            method:
              (args.method as string) ??
              (nestedRequest?.method as string) ??
              "GET",
            uri,
            startTime: Date.now(),
          });
        }
        const req = this.requests.get(id);
        if (req && (args.statusCode || args.status)) {
          req.endTime = Date.now();
          req.statusCode =
            (args.statusCode as number) ?? (args.status as number);
        }
        continue;
      }

      if (
        name.includes("httpClient.request.start") ||
        name === "HttpProfileRequest"
      ) {
        const id =
          args.id?.toString() ??
          args.requestId?.toString() ??
          `${args.uri ?? args.url ?? name}_${args.startTime ?? event.ph}`;
        if (this.requests.has(id)) continue;
        this.requests.set(id, {
          id,
          method: (args.method as string) ?? "GET",
          uri: (args.uri as string) ?? (args.url as string) ?? "unknown",
          startTime: Date.now(),
        });
      }

      if (
        name.includes("httpClient.request.finish") ||
        name === "HttpProfileRequestResponse"
      ) {
        const id =
          args.id?.toString() ??
          args.requestId?.toString() ??
          `${args.uri ?? args.url ?? name}_${args.startTime}`;
        const req = id ? this.requests.get(id) : undefined;
        if (req && !req.endTime) {
          req.endTime = Date.now();
          req.statusCode =
            (args.statusCode as number) ?? (args.status as number);
          req.responseSize =
            (args.contentLength as number) ?? (args.responseSize as number);
        }
      }
    }
  }
}
