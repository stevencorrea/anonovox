import { BasicTracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace, SpanStatusCode, context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import os from "node:os";

// ── Ring-buffer span exporter ──────────────────────────────────────────────

const MAX_SPANS = 500;

export type SpanRecord = {
  traceId: string;
  spanId: string;
  name: string;
  startTimeMs: number;
  durationMs: number;
  status: "ok" | "error" | "unset";
  route?: string;
  method?: string;
  httpStatus?: number;
};

class RingBufferExporter implements SpanExporter {
  private spans: SpanRecord[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: { code: 0 | 1 }) => void): void {
    for (const span of spans) {
      const ctx = span.spanContext();
      const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
      const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
      this.spans.unshift({
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        name: span.name,
        startTimeMs: startMs,
        durationMs: Math.max(0, endMs - startMs),
        status:
          span.status.code === SpanStatusCode.ERROR
            ? "error"
            : span.status.code === SpanStatusCode.OK
              ? "ok"
              : "unset",
        route: span.attributes["http.route"] as string | undefined,
        method: span.attributes["http.method"] as string | undefined,
        httpStatus: span.attributes["http.status_code"] as number | undefined,
      });
      if (this.spans.length > MAX_SPANS) this.spans.length = MAX_SPANS;
    }
    resultCallback({ code: 0 });
  }

  getSpans(limit = 100): SpanRecord[] {
    return this.spans.slice(0, limit);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ── In-memory metrics ──────────────────────────────────────────────────────

type RouteStat = {
  count: number;
  errors: number;
  totalMs: number;
  samples: number[];
};

type MinuteBucket = {
  ts: number;
  count: number;
  errors: number;
};

const routeStats = new Map<string, RouteStat>();
const minuteBuckets: MinuteBucket[] = [];
const BUCKET_MINUTES = 60;

function getCurrentBucket(): MinuteBucket {
  const ts = Math.floor(Date.now() / 60_000);
  const last = minuteBuckets[minuteBuckets.length - 1];
  if (last && last.ts === ts) return last;
  const bucket: MinuteBucket = { ts, count: 0, errors: 0 };
  minuteBuckets.push(bucket);
  while (minuteBuckets.length > BUCKET_MINUTES) minuteBuckets.shift();
  return bucket;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── OTel provider setup ────────────────────────────────────────────────────

const spanExporter = new RingBufferExporter();

const ctxManager = new AsyncLocalStorageContextManager();
ctxManager.enable();
context.setGlobalContextManager(ctxManager);

const spanProcessors = [new SimpleSpanProcessor(spanExporter)];

// Export to Jaeger (or any OTLP collector) when endpoint is configured.
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (otlpEndpoint) {
  const otlpExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });
  spanProcessors.push(new BatchSpanProcessor(otlpExporter));
}

const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "anonovox" }),
  spanProcessors,
});
trace.setGlobalTracerProvider(provider);

const tracer = trace.getTracer("anonovox", "1.0.0");

// ── Route instrumentation wrapper ──────────────────────────────────────────

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

type RouteHandler = (req: Request) => Promise<Response>;
type RouteMap = Record<string, RouteHandler>;
type Routes = Record<string, unknown>;

function wrapHandler(method: string, path: string, handler: RouteHandler): RouteHandler {
  return async (req: Request) => {
    const span = tracer.startSpan(`${method} ${path}`, {
      attributes: { "http.method": method, "http.route": path },
    });
    const startMs = performance.now();
    let status = 500;
    try {
      const response = await context.with(trace.setSpan(context.active(), span), () =>
        handler(req),
      );
      status = response.status;
      span.setAttribute("http.status_code", status);
      span.setStatus({ code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      return response;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
      recordRequest(`${method}:${path}`, status, performance.now() - startMs);
    }
  };
}

export function instrumentRoutes(routes: Routes): Routes {
  const result: Routes = {};
  for (const [path, value] of Object.entries(routes)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.some(([k]) => HTTP_METHODS.has(k))) {
        const wrapped: Record<string, unknown> = {};
        for (const [method, fn] of entries) {
          wrapped[method] =
            HTTP_METHODS.has(method) && typeof fn === "function"
              ? wrapHandler(method, path, fn as RouteHandler)
              : fn;
        }
        result[path] = wrapped;
        continue;
      }
    }
    result[path] = value;
  }
  return result;
}

// ── Metric recording ───────────────────────────────────────────────────────

function recordRequest(key: string, status: number, durationMs: number): void {
  let stat = routeStats.get(key);
  if (!stat) {
    stat = { count: 0, errors: 0, totalMs: 0, samples: [] };
    routeStats.set(key, stat);
  }
  stat.count++;
  if (status >= 500) stat.errors++;
  stat.totalMs += durationMs;
  stat.samples.push(durationMs);
  if (stat.samples.length > 200) stat.samples.shift();

  const bucket = getCurrentBucket();
  bucket.count++;
  if (status >= 500) bucket.errors++;
}

// ── Public data exports ────────────────────────────────────────────────────

export type MetricsSnapshot = {
  routes: Array<{
    key: string;
    count: number;
    errors: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
  }>;
  timeSeries: Array<{ ts: number; count: number; errors: number }>;
  totals: { requests: number; errors: number; errorRate: number };
};

export function getMetricsSnapshot(): MetricsSnapshot {
  const routes = [...routeStats.entries()].map(([key, s]) => {
    const sorted = [...s.samples].sort((a, b) => a - b);
    return {
      key,
      count: s.count,
      errors: s.errors,
      avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
      p50Ms: Math.round(percentile(sorted, 50)),
      p95Ms: Math.round(percentile(sorted, 95)),
    };
  });

  const nowMinute = Math.floor(Date.now() / 60_000);
  const timeSeries = Array.from({ length: BUCKET_MINUTES }, (_, i) => {
    const minute = nowMinute - BUCKET_MINUTES + 1 + i;
    const bucket = minuteBuckets.find((b) => b.ts === minute);
    return { ts: minute * 60_000, count: bucket?.count ?? 0, errors: bucket?.errors ?? 0 };
  });

  const totals = [...routeStats.values()].reduce(
    (acc, s) => ({ requests: acc.requests + s.count, errors: acc.errors + s.errors }),
    { requests: 0, errors: 0 },
  );

  return {
    routes: routes.sort((a, b) => b.count - a.count),
    timeSeries,
    totals: {
      ...totals,
      errorRate: totals.requests
        ? Math.round((totals.errors / totals.requests) * 1000) / 10
        : 0,
    },
  };
}

export function getRecentSpans(limit = 100): SpanRecord[] {
  return spanExporter.getSpans(limit);
}

export type SystemInfo = {
  bunVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  uptimeSeconds: number;
};

export function getSystemInfo(): SystemInfo {
  const mem = process.memoryUsage();
  return {
    bunVersion: Bun.version,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    memoryMb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    uptimeSeconds: Math.round(process.uptime()),
  };
}
