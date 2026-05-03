import { authClient } from "./auth-client";

type InsightsResult = {
  themes: string[];
  sentiment: { positive: number; neutral: number; negative: number };
  key_quotes: string[];
  overall_summary: string;
};
type FeedItem = { id: string; content: string; created_at: string };
type LeadershipResponse = { id: string; content: string; period_label: string | null; posted_at: string };
type Delivery = { id: string; recipient_count: number; feedback_count: number; status: string; error: string | null; sent_at: string };

// ── DOM refs ──────────────────────────────────────────────────────────────────

const loadingEl = document.getElementById("dashboard-loading") as HTMLElement;
const errorEl = document.getElementById("dashboard-error") as HTMLElement;
const accessDeniedEl = document.getElementById("dashboard-access-denied") as HTMLElement;
const contentEl = document.getElementById("dashboard-content") as HTMLElement;

const insightsLoading = document.getElementById("insights-loading") as HTMLElement;
const insightsContent = document.getElementById("insights-content") as HTMLElement;
const insightsEmpty = document.getElementById("insights-empty") as HTMLElement;
const themesEl = document.getElementById("insights-themes") as HTMLElement;
const sentimentEl = document.getElementById("insights-sentiment") as HTMLElement;
const quotesEl = document.getElementById("insights-quotes") as HTMLElement;
const summaryEl = document.getElementById("insights-summary") as HTMLElement;
const generatedAtEl = document.getElementById("insights-generated-at") as HTMLElement;
const refreshBtn = document.getElementById("refresh-insights-btn") as HTMLButtonElement;

const respondForm = document.getElementById("respond-form") as HTMLFormElement;
const respondContent = document.getElementById("respond-content") as HTMLTextAreaElement;
const respondPeriod = document.getElementById("respond-period") as HTMLInputElement;
const respondMsg = document.getElementById("respond-msg") as HTMLElement;
const responsesList = document.getElementById("responses-list") as HTMLElement;
const responsesSection = document.getElementById("responses-section") as HTMLElement;

const feedList = document.getElementById("feed-list") as HTMLElement;
const feedEmpty = document.getElementById("feed-empty") as HTMLElement;
const loadMoreBtn = document.getElementById("load-more-btn") as HTMLButtonElement;
const feedCountEl = document.getElementById("feed-count") as HTMLElement;

const deliveriesCard = document.getElementById("deliveries-card") as HTMLElement;
const deliveriesList = document.getElementById("deliveries-list") as HTMLElement;
const deliveriesEmpty = document.getElementById("deliveries-empty") as HTMLElement;

// ── State ─────────────────────────────────────────────────────────────────────

let currentOffset = 0;
let totalFeedItems = 0;
const PAGE_SIZE = 20;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  const session = await authClient.getSession();
  if (!session?.data?.user) {
    window.location.href = "/signin";
    return;
  }

  const meRes = await fetch("/api/org/me");
  if (!meRes.ok) {
    showError("Failed to load organization info.");
    return;
  }
  const me = await meRes.json() as { orgId: string | null; role: string | null };
  if (!me.orgId || !["owner", "admin"].includes(me.role ?? "")) {
    loadingEl.style.display = "none";
    accessDeniedEl.style.display = "block";
    return;
  }

  try {
    const [insightsRes, feedRes, responsesRes, deliveriesRes] = await Promise.all([
      fetch("/api/dashboard/insights"),
      fetch(`/api/dashboard/feed?offset=0&limit=${PAGE_SIZE}`),
      fetch("/api/dashboard/responses"),
      fetch("/api/dashboard/deliveries"),
    ]);

    if (!insightsRes.ok || !feedRes.ok || !responsesRes.ok || !deliveriesRes.ok) {
      throw new Error("Failed to load dashboard data");
    }

    const insightsData = await insightsRes.json() as { insights: InsightsResult | null; generated_at: string | null };
    const feedData = await feedRes.json() as { items: FeedItem[]; total: number };
    const responsesData = await responsesRes.json() as { responses: LeadershipResponse[] };
    const deliveriesData = await deliveriesRes.json() as { deliveries: Delivery[] };

    totalFeedItems = feedData.total;
    currentOffset = feedData.items.length;

    renderInsights(insightsData.insights, insightsData.generated_at);
    renderFeed(feedData.items, false);
    renderResponses(responsesData.responses);
    renderDeliveries(deliveriesData.deliveries);

    loadingEl.style.display = "none";
    contentEl.style.display = "block";
  } catch (err) {
    console.error("Dashboard load error:", err);
    showError("Failed to load dashboard. Please refresh.");
  }
})();

// ── Render insights ───────────────────────────────────────────────────────────

function renderInsights(insights: InsightsResult | null, generated_at: string | null) {
  insightsLoading.style.display = "none";
  if (!insights) {
    insightsEmpty.style.display = "block";
    insightsContent.style.display = "none";
    return;
  }

  insightsEmpty.style.display = "none";
  insightsContent.style.display = "block";

  themesEl.innerHTML = insights.themes
    .map((t) => `<span class="theme-chip">${escHtml(t)}</span>`)
    .join("");

  const { positive, neutral, negative } = insights.sentiment;
  sentimentEl.innerHTML = `
    <div class="sentiment-bar">
      <div class="sentiment-seg sentiment-pos" style="width:${positive}%" title="Positive ${positive}%"></div>
      <div class="sentiment-seg sentiment-neu" style="width:${neutral}%" title="Neutral ${neutral}%"></div>
      <div class="sentiment-seg sentiment-neg" style="width:${negative}%" title="Negative ${negative}%"></div>
    </div>
    <div class="sentiment-legend">
      <span><span class="legend-dot legend-pos"></span>Positive ${positive}%</span>
      <span><span class="legend-dot legend-neu"></span>Neutral ${neutral}%</span>
      <span><span class="legend-dot legend-neg"></span>Negative ${negative}%</span>
    </div>`;

  quotesEl.innerHTML = insights.key_quotes
    .map((q) => `<blockquote class="key-quote">"${escHtml(q)}"</blockquote>`)
    .join("");

  summaryEl.textContent = insights.overall_summary;

  if (generated_at) {
    generatedAtEl.textContent = `Last generated ${relativeTime(generated_at)}`;
  }
}

// ── Render feed ───────────────────────────────────────────────────────────────

function renderFeed(items: FeedItem[], append: boolean) {
  if (!append) feedList.innerHTML = "";

  if (items.length === 0 && !append) {
    feedEmpty.style.display = "block";
    loadMoreBtn.style.display = "none";
    feedCountEl.textContent = "0 responses";
    return;
  }

  feedEmpty.style.display = "none";
  feedCountEl.textContent = `${totalFeedItems} response${totalFeedItems !== 1 ? "s" : ""}`;

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "feed-item";
    el.innerHTML = `
      <div class="feed-content">${escHtml(item.content)}</div>
      <div class="feed-meta">${relativeTime(item.created_at)}</div>`;
    feedList.appendChild(el);
  }

  loadMoreBtn.style.display = currentOffset < totalFeedItems ? "block" : "none";
}

// ── Render responses ──────────────────────────────────────────────────────────

function renderResponses(responses: LeadershipResponse[]) {
  if (responses.length === 0) {
    responsesSection.style.display = "none";
    return;
  }
  responsesSection.style.display = "block";
  responsesList.innerHTML = "";
  for (const r of responses) {
    const el = document.createElement("div");
    el.className = "response-item";
    el.innerHTML = `
      ${r.period_label ? `<div class="response-period">${escHtml(r.period_label)}</div>` : ""}
      <div class="response-content">${escHtml(r.content)}</div>
      <div class="response-meta">${relativeTime(r.posted_at)}</div>`;
    responsesList.appendChild(el);
  }
}

// ── Render delivery history ───────────────────────────────────────────────────

function renderDeliveries(deliveries: Delivery[]) {
  deliveriesCard.style.display = "block";
  if (deliveries.length === 0) {
    deliveriesEmpty.style.display = "block";
    return;
  }
  deliveriesEmpty.style.display = "none";
  deliveriesList.innerHTML = "";
  for (const d of deliveries) {
    const el = document.createElement("div");
    el.className = "delivery-row";
    const badgeClass = d.status === "sent" ? "delivery-badge-sent" : "delivery-badge-failed";
    el.innerHTML = `
      <span class="delivery-date">${relativeTime(d.sent_at)}</span>
      <span class="delivery-count">${d.feedback_count} submission${d.feedback_count !== 1 ? "s" : ""} · ${d.recipient_count} recipient${d.recipient_count !== 1 ? "s" : ""}</span>
      <span class="delivery-badge ${badgeClass}">${d.status}</span>`;
    deliveriesList.appendChild(el);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Refreshing…";
  insightsContent.style.display = "none";
  insightsEmpty.style.display = "none";
  insightsLoading.style.display = "block";
  try {
    const res = await fetch("/api/dashboard/insights/refresh", { method: "POST" });
    const data = await res.json() as { insights: InsightsResult | null; generated_at: string | null };
    renderInsights(data.insights, data.generated_at);
  } catch {
    insightsLoading.style.display = "none";
    insightsEmpty.style.display = "block";
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh insights";
  }
});

respondForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = respondContent.value.trim();
  if (!content) return;

  const submitBtn = respondForm.querySelector("button[type='submit']") as HTMLButtonElement;
  submitBtn.disabled = true;
  submitBtn.textContent = "Posting…";
  setMsg(respondMsg, "", "");

  try {
    const res = await fetch("/api/dashboard/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, period_label: respondPeriod.value.trim() || null }),
    });
    if (!res.ok) throw new Error("Failed");
    respondContent.value = "";
    respondPeriod.value = "";
    setMsg(respondMsg, "Response posted successfully.", "success");

    const responsesRes = await fetch("/api/dashboard/responses");
    const responsesData = await responsesRes.json() as { responses: LeadershipResponse[] };
    renderResponses(responsesData.responses);
  } catch {
    setMsg(respondMsg, "Failed to post response.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Post response";
  }
});

loadMoreBtn.addEventListener("click", async () => {
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";
  try {
    const res = await fetch(`/api/dashboard/feed?offset=${currentOffset}&limit=${PAGE_SIZE}`);
    const data = await res.json() as { items: FeedItem[]; total: number };
    totalFeedItems = data.total;
    currentOffset += data.items.length;
    renderFeed(data.items, true);
  } catch {
    // silently ignore
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showError(msg: string) {
  loadingEl.style.display = "none";
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

function setMsg(el: HTMLElement, text: string, type: "success" | "error" | "") {
  el.textContent = text;
  el.className = `inline-msg ${type}`;
  el.style.display = text ? "block" : "none";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
