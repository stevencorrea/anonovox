import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

// ── Types matching server responses ───────────────────────────────────────

type SystemPayload = {
  node: {
    bunVersion: string;
    hostname: string;
    platform: string;
    arch: string;
    memoryMb: { rss: number; heapUsed: number; heapTotal: number };
    uptimeSeconds: number;
  };
  db: {
    connected: boolean;
    version: string;
    database: string;
    postgresUptimeSince: string | null;
  };
  integrations: {
    orgs: number;
    users: number;
    slackWorkspaces: number;
    teamstenants: number;
  };
};

type MetricsPayload = {
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

type SpanRecord = {
  name: string;
  startTimeMs: number;
  durationMs: number;
  status: "ok" | "error" | "unset";
};

// ── DOM helpers ───────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function kv(key: string, value: string | number): string {
  return `<div class="kv-row"><span class="kv-key">${key}</span><span class="kv-val">${value}</span></div>`;
}

function badge(ok: boolean, label: string): string {
  return `<span class="badge badge-${ok ? "ok" : "error"}">${label}</span>`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function dotStatus(status: "ok" | "error" | "unset"): string {
  return `<span class="status-dot dot-${status}"></span>`;
}

// ── Chart instance (kept for updates) ────────────────────────────────────

let requestsChart: Chart | null = null;

function renderChart(timeSeries: MetricsPayload["timeSeries"]): void {
  const labels = timeSeries.map((b) => {
    const d = new Date(b.ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  });
  const counts = timeSeries.map((b) => b.count);
  const errors = timeSeries.map((b) => b.errors);

  const ctx = (document.getElementById("requests-chart") as HTMLCanvasElement).getContext("2d")!;

  if (requestsChart) {
    requestsChart.data.labels = labels;
    (requestsChart.data.datasets[0] as any).data = counts;
    (requestsChart.data.datasets[1] as any).data = errors;
    requestsChart.update("none");
    return;
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const errColor = getComputedStyle(document.documentElement).getPropertyValue("--error").trim();

  requestsChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Requests",
          data: counts,
          borderColor: accent,
          backgroundColor: accent + "18",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: "Errors",
          data: errors,
          borderColor: errColor,
          backgroundColor: errColor + "18",
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: true, position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 10 } },
          grid: { color: "rgba(128,128,128,0.1)" },
        },
      },
    },
  });
}

// ── Render functions ──────────────────────────────────────────────────────

function renderSystem(data: SystemPayload): void {
  const { node, db, integrations } = data;

  $("stat-uptime").textContent = formatUptime(node.uptimeSeconds);
  $("stat-hostname").textContent = node.hostname;

  $("node-info").innerHTML = [
    kv("Bun version", `v${node.bunVersion}`),
    kv("Platform", `${node.platform} / ${node.arch}`),
    kv("RSS memory", `${node.memoryMb.rss} MB`),
    kv("Heap used", `${node.memoryMb.heapUsed} / ${node.memoryMb.heapTotal} MB`),
    kv("Uptime", formatUptime(node.uptimeSeconds)),
  ].join("");

  $("db-info").innerHTML = [
    kv("Status", badge(db.connected, db.connected ? "Connected" : "Disconnected")),
    kv("Database", db.database),
    db.version ? kv("Version", db.version.split(" ").slice(0, 2).join(" ")) : "",
    db.postgresUptimeSince ? kv("PG up since", new Date(db.postgresUptimeSince).toLocaleString()) : "",
  ]
    .filter(Boolean)
    .join("");

  $("services-row").innerHTML = [
    { label: "Organizations", value: integrations.orgs },
    { label: "Users", value: integrations.users },
    { label: "Slack Workspaces", value: integrations.slackWorkspaces },
    { label: "Teams Tenants", value: integrations.teamstenants },
  ]
    .map(
      ({ label, value }) => `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
      </div>`,
    )
    .join("");
}

function renderMetrics(data: MetricsPayload): void {
  const { routes, timeSeries, totals } = data;

  $("stat-requests").textContent = totals.requests.toLocaleString();

  const errEl = $("stat-error-rate");
  errEl.textContent = `${totals.errorRate}%`;
  errEl.className = `stat-value${totals.errorRate > 5 ? " error" : totals.errorRate === 0 ? " ok" : ""}`;

  const totalAvgMs =
    routes.length > 0
      ? Math.round(routes.reduce((s, r) => s + r.avgMs * r.count, 0) / Math.max(1, totals.requests))
      : 0;
  $("stat-avg-latency").textContent = `${totalAvgMs}ms`;

  renderChart(timeSeries);

  const tbody = $("routes-body");
  if (!routes.length) {
    $("routes-empty").style.display = "";
    tbody.innerHTML = "";
    return;
  }
  $("routes-empty").style.display = "none";
  tbody.innerHTML = routes
    .map(
      (r) => `
    <tr>
      <td class="mono">${r.key}</td>
      <td style="text-align:right">${r.count.toLocaleString()}</td>
      <td style="text-align:right;color:${r.errors > 0 ? "var(--error)" : "inherit"}">${r.errors}</td>
      <td style="text-align:right">${r.avgMs}</td>
      <td style="text-align:right">${r.p50Ms}</td>
      <td style="text-align:right">${r.p95Ms}</td>
    </tr>`,
    )
    .join("");
}

function renderSpans(spans: SpanRecord[]): void {
  const tbody = $("spans-body");
  if (!spans.length) {
    $("spans-empty").style.display = "";
    tbody.innerHTML = "";
    return;
  }
  $("spans-empty").style.display = "none";
  tbody.innerHTML = spans
    .slice(0, 80)
    .map(
      (s) => `
    <tr>
      <td class="mono">${s.name}</td>
      <td style="text-align:right">${formatDuration(s.durationMs)}</td>
      <td>${dotStatus(s.status)}${s.status}</td>
      <td style="text-align:right;color:var(--text-tertiary)">${formatTime(s.startTimeMs)}</td>
    </tr>`,
    )
    .join("");
}

// ── Data fetching ─────────────────────────────────────────────────────────

async function fetchAll(): Promise<void> {
  const [sysRes, metricsRes, spansRes] = await Promise.all([
    fetch("/api/admin/system"),
    fetch("/api/admin/metrics"),
    fetch("/api/admin/spans"),
  ]);

  if (sysRes.status === 401 || sysRes.status === 403) {
    $("loading").style.display = "none";
    $("access-denied").textContent =
      sysRes.status === 401
        ? "Sign in with an anonovox staff account to access this page."
        : "Staff access required. Sign in with an anonovox account.";
    $("access-denied").style.display = "";
    return;
  }
  if (!sysRes.ok || !metricsRes.ok || !spansRes.ok) {
    $("loading").style.display = "none";
    $("error-state").style.display = "";
    return;
  }

  const [sys, metrics, spans] = await Promise.all([
    sysRes.json() as Promise<SystemPayload>,
    metricsRes.json() as Promise<MetricsPayload>,
    spansRes.json() as Promise<SpanRecord[]>,
  ]);

  renderSystem(sys);
  renderMetrics(metrics);
  renderSpans(spans);

  $("loading").style.display = "none";
  $("content").style.display = "block";
  $("last-refresh").textContent = `Last updated ${new Date().toLocaleTimeString()}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────

fetchAll().catch(console.error);

$("refresh-btn").addEventListener("click", () => {
  fetchAll().catch(console.error);
});

setInterval(() => fetchAll().catch(console.error), 30_000);
