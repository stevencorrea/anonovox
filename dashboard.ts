import { authClient } from "./auth-client";

type InsightsResult = {
  themes: string[];
  sentiment: { positive: number; neutral: number; negative: number };
  key_quotes: string[];
  overall_summary: string;
};
type StructuredPollSummary = {
  id: string;
  question: string;
  status: "active" | "closed";
  created_at: string;
  closed_at: string | null;
  totalResponses: number;
  breakdown: Array<{ id: string; label: string; count: number; percentage: number }>;
  notes: Array<{ id: string; comment: string; created_at: string }>;
};
type FeedItem = { id: string; content: string; created_at: string };
type LeadershipResponse = { id: string; content: string; period_label: string | null; posted_at: string };
type Delivery = { id: string; recipient_count: number; feedback_count: number; status: string; error: string | null; sent_at: string };

// ── DOM refs ──────────────────────────────────────────────────────────────────

const loadingEl = document.getElementById("dashboard-loading") as HTMLElement;
const errorEl = document.getElementById("dashboard-error") as HTMLElement;
const accessDeniedEl = document.getElementById("dashboard-access-denied") as HTMLElement;
const contentEl = document.getElementById("dashboard-content") as HTMLElement;
const overviewFeedbackCountEl = document.getElementById("overview-feedback-count") as HTMLElement;
const overviewFeedbackDetailEl = document.getElementById("overview-feedback-detail") as HTMLElement;
const overviewNegativeSentimentEl = document.getElementById("overview-negative-sentiment") as HTMLElement;
const overviewSentimentDetailEl = document.getElementById("overview-sentiment-detail") as HTMLElement;
const overviewPollCountEl = document.getElementById("overview-poll-count") as HTMLElement;
const overviewPollDetailEl = document.getElementById("overview-poll-detail") as HTMLElement;
const overviewResponseCountEl = document.getElementById("overview-response-count") as HTMLElement;
const overviewResponseDetailEl = document.getElementById("overview-response-detail") as HTMLElement;

const insightsLoading = document.getElementById("insights-loading") as HTMLElement;
const insightsContent = document.getElementById("insights-content") as HTMLElement;
const insightsEmpty = document.getElementById("insights-empty") as HTMLElement;
const themesEl = document.getElementById("insights-themes") as HTMLElement;
const sentimentEl = document.getElementById("insights-sentiment") as HTMLElement;
const quotesEl = document.getElementById("insights-quotes") as HTMLElement;
const summaryEl = document.getElementById("insights-summary") as HTMLElement;
const generatedAtEl = document.getElementById("insights-generated-at") as HTMLElement;
const refreshBtn = document.getElementById("refresh-insights-btn") as HTMLButtonElement;

const pollLoadingEl = document.getElementById("poll-loading") as HTMLElement;
const pollEmptyEl = document.getElementById("poll-empty") as HTMLElement;
const pollViewEl = document.getElementById("poll-view") as HTMLElement;
const pollQuestionEl = document.getElementById("poll-question") as HTMLElement;
const pollStatusEl = document.getElementById("poll-status") as HTMLElement;
const pollResponseCountEl = document.getElementById("poll-response-count") as HTMLElement;
const pollBreakdownEl = document.getElementById("poll-breakdown") as HTMLElement;
const pollNotesEl = document.getElementById("poll-notes") as HTMLElement;
const pollCloseBtn = document.getElementById("poll-close-btn") as HTMLButtonElement;
const pollDeleteBtn = document.getElementById("poll-delete-btn") as HTMLButtonElement;
const pollBuilderForm = document.getElementById("poll-builder-form") as HTMLFormElement;
const pollBuilderQuestion = document.getElementById("poll-builder-question") as HTMLTextAreaElement;
const pollBuilderOptions = document.getElementById("poll-builder-options") as HTMLTextAreaElement;
const pollBuilderSubmit = document.getElementById("poll-builder-submit") as HTMLButtonElement;
const pollMsg = document.getElementById("poll-msg") as HTMLElement;

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
let currentPoll: StructuredPollSummary | null = null;
let currentInsights: InsightsResult | null = null;
let currentResponses: LeadershipResponse[] = [];
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
    showError(await readApiError(meRes, "Failed to load organization info."));
    return;
  }
  const me = await meRes.json() as { orgId: string | null; role: string | null };
  if (!me.orgId || !["owner", "admin"].includes(me.role ?? "")) {
    loadingEl.style.display = "none";
    accessDeniedEl.style.display = "block";
    return;
  }

  try {
    const [insightsRes, pollRes, feedRes, responsesRes, deliveriesRes] = await Promise.all([
      fetch("/api/dashboard/insights"),
      fetch("/api/dashboard/poll"),
      fetch(`/api/dashboard/feed?offset=0&limit=${PAGE_SIZE}`),
      fetch("/api/dashboard/responses"),
      fetch("/api/dashboard/deliveries"),
    ]);

    if (!insightsRes.ok || !pollRes.ok || !feedRes.ok || !responsesRes.ok || !deliveriesRes.ok) {
      throw new Error("Failed to load dashboard data");
    }

    const insightsData = await insightsRes.json() as { insights: InsightsResult | null; generated_at: string | null };
    const pollData = await pollRes.json() as { poll: StructuredPollSummary | null };
    const feedData = await feedRes.json() as { items: FeedItem[]; total: number };
    const responsesData = await responsesRes.json() as { responses: LeadershipResponse[] };
    const deliveriesData = await deliveriesRes.json() as { deliveries: Delivery[] };

    totalFeedItems = feedData.total;
    currentOffset = feedData.items.length;
    currentResponses = responsesData.responses;

    renderExecutiveOverview(feedData.total, insightsData.insights, pollData.poll, responsesData.responses);
    renderInsights(insightsData.insights, insightsData.generated_at);
    renderPoll(pollData.poll);
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

function renderExecutiveOverview(
  feedbackCount: number,
  insights: InsightsResult | null,
  poll: StructuredPollSummary | null,
  responses: LeadershipResponse[],
) {
  overviewFeedbackCountEl.textContent = String(feedbackCount);
  overviewFeedbackDetailEl.textContent =
    feedbackCount > 0
      ? `Latest signal spans ${feedbackCount} anonymized submission${feedbackCount !== 1 ? "s" : ""}.`
      : "No feedback captured yet.";

  const negative = insights?.sentiment.negative ?? 0;
  overviewNegativeSentimentEl.textContent = `${negative}%`;
  overviewSentimentDetailEl.textContent = insights
    ? negative >= 40
      ? "High friction signal. Leaders should review workload, clarity, and trust themes first."
      : "Current AI read is mixed-to-stable; use quotes and themes for nuance."
    : "AI analysis will summarize team sentiment here.";

  overviewPollCountEl.textContent = String(poll?.totalResponses ?? 0);
  overviewPollDetailEl.textContent = poll
    ? `${poll.status === "active" ? "Active" : "Latest"} poll: ${poll.question}`
    : "No structured poll is active.";

  overviewResponseCountEl.textContent = String(responses.length);
  const latestResponse = responses[0];
  overviewResponseDetailEl.textContent = responses.length > 0
    ? `Most recent response ${relativeTime(latestResponse?.posted_at ?? new Date().toISOString())}.`
    : "No leadership responses posted yet.";
}

function renderInsights(insights: InsightsResult | null, generated_at: string | null) {
  currentInsights = insights;
  renderExecutiveOverview(totalFeedItems, insights, currentPoll, currentResponses);
  insightsLoading.style.display = "none";
  if (!insights) {
    insightsEmpty.style.display = "block";
    insightsContent.style.display = "none";
    return;
  }

  insightsEmpty.style.display = "none";
  insightsContent.style.display = "block";

  themesEl.replaceChildren(
    ...insights.themes.map((theme) => {
      const chip = document.createElement("span");
      chip.className = "theme-chip";
      chip.textContent = theme;
      return chip;
    }),
  );

  const { positive, neutral, negative } = insights.sentiment;
  const sentimentBar = document.createElement("div");
  sentimentBar.className = "sentiment-bar";
  for (const [className, value, label] of [
    ["sentiment-pos", positive, "Positive"],
    ["sentiment-neu", neutral, "Neutral"],
    ["sentiment-neg", negative, "Negative"],
  ] as const) {
    const segment = document.createElement("div");
    segment.className = `sentiment-seg ${className}`;
    segment.style.width = `${value}%`;
    segment.title = `${label} ${value}%`;
    sentimentBar.appendChild(segment);
  }

  const sentimentLegend = document.createElement("div");
  sentimentLegend.className = "sentiment-legend";
  for (const [className, label, value] of [
    ["legend-pos", "Positive", positive],
    ["legend-neu", "Neutral", neutral],
    ["legend-neg", "Negative", negative],
  ] as const) {
    const wrapper = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = `legend-dot ${className}`;
    wrapper.append(dot, `${label} ${value}%`);
    sentimentLegend.appendChild(wrapper);
  }

  sentimentEl.replaceChildren(sentimentBar, sentimentLegend);

  quotesEl.replaceChildren(
    ...insights.key_quotes.map((quote) => {
      const blockquote = document.createElement("blockquote");
      blockquote.className = "key-quote";
      blockquote.textContent = `"${quote}"`;
      return blockquote;
    }),
  );

  summaryEl.textContent = insights.overall_summary;

  if (generated_at) {
    generatedAtEl.textContent = `Last generated ${relativeTime(generated_at)}`;
  }
}

function renderPoll(poll: StructuredPollSummary | null) {
  currentPoll = poll;
  renderExecutiveOverview(totalFeedItems, currentInsights, poll, currentResponses);
  pollLoadingEl.style.display = "none";
  pollEmptyEl.style.display = poll ? "none" : "block";
  pollViewEl.style.display = poll ? "block" : "none";

  const hasActivePoll = poll?.status === "active";
  pollBuilderForm.style.display = hasActivePoll ? "none" : "block";

  if (!poll) {
    pollBreakdownEl.replaceChildren();
    pollNotesEl.replaceChildren();
    pollNotesEl.style.display = "none";
    return;
  }

  pollQuestionEl.textContent = poll.question;
  pollStatusEl.textContent = poll.status;
  pollStatusEl.className = `poll-status-badge ${poll.status === "active" ? "poll-status-active" : "poll-status-closed"}`;
  pollResponseCountEl.textContent = `${poll.totalResponses} response${poll.totalResponses !== 1 ? "s" : ""}`;

  pollBreakdownEl.replaceChildren(
    ...poll.breakdown.map((option) => {
      const row = document.createElement("div");
      row.className = "poll-breakdown-row";

      const label = document.createElement("div");
      label.className = "poll-breakdown-label";
      const left = document.createElement("span");
      left.textContent = option.label;
      const right = document.createElement("span");
      right.textContent = `${option.count} · ${option.percentage}%`;
      label.append(left, right);

      const bar = document.createElement("div");
      bar.className = "poll-breakdown-bar";
      const fill = document.createElement("div");
      fill.className = "poll-breakdown-fill";
      fill.style.width = `${option.percentage}%`;
      bar.appendChild(fill);

      row.append(label, bar);
      return row;
    }),
  );

  pollNotesEl.replaceChildren();
  if (poll.notes.length > 0) {
    pollNotesEl.style.display = "grid";
    const heading = document.createElement("div");
    heading.className = "card-title";
    heading.textContent = "Anonymous notes";
    heading.style.marginBottom = "0";
    pollNotesEl.appendChild(heading);

    for (const note of poll.notes) {
      const card = document.createElement("div");
      card.className = "poll-note";
      const text = document.createElement("div");
      text.className = "poll-note-text";
      text.textContent = note.comment;
      const meta = document.createElement("div");
      meta.className = "poll-note-meta";
      meta.textContent = relativeTime(note.created_at);
      card.append(text, meta);
      pollNotesEl.appendChild(card);
    }
  } else {
    pollNotesEl.style.display = "none";
  }

  pollCloseBtn.style.display = poll.status === "active" ? "inline-flex" : "none";
}

// ── Render feed ───────────────────────────────────────────────────────────────

function renderFeed(items: FeedItem[], append: boolean) {
  renderExecutiveOverview(totalFeedItems, currentInsights, currentPoll, currentResponses);
  if (!append) feedList.replaceChildren();

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
    const content = document.createElement("div");
    content.className = "feed-content";
    content.textContent = item.content;
    const meta = document.createElement("div");
    meta.className = "feed-meta";
    meta.textContent = relativeTime(item.created_at);
    el.append(content, meta);
    feedList.appendChild(el);
  }

  loadMoreBtn.style.display = currentOffset < totalFeedItems ? "block" : "none";
}

// ── Render responses ──────────────────────────────────────────────────────────

function renderResponses(responses: LeadershipResponse[]) {
  currentResponses = responses;
  renderExecutiveOverview(totalFeedItems, currentInsights, currentPoll, responses);
  if (responses.length === 0) {
    responsesSection.style.display = "none";
    return;
  }
  responsesSection.style.display = "block";
  responsesList.replaceChildren();
  for (const r of responses) {
    const el = document.createElement("div");
    el.className = "response-item";
    if (r.period_label) {
      const period = document.createElement("div");
      period.className = "response-period";
      period.textContent = r.period_label;
      el.appendChild(period);
    }
    const content = document.createElement("div");
    content.className = "response-content";
    content.textContent = r.content;
    const meta = document.createElement("div");
    meta.className = "response-meta";
    meta.textContent = relativeTime(r.posted_at);
    el.append(content, meta);
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
  deliveriesList.replaceChildren();
  for (const d of deliveries) {
    const el = document.createElement("div");
    el.className = "delivery-row";
    const badgeClass = d.status === "sent" ? "delivery-badge-sent" : "delivery-badge-failed";
    const date = document.createElement("span");
    date.className = "delivery-date";
    date.textContent = relativeTime(d.sent_at);
    const count = document.createElement("span");
    count.className = "delivery-count";
    count.textContent = `${d.feedback_count} submission${d.feedback_count !== 1 ? "s" : ""} · ${d.recipient_count} recipient${d.recipient_count !== 1 ? "s" : ""}`;
    const badge = document.createElement("span");
    badge.className = `delivery-badge ${badgeClass}`;
    badge.textContent = d.status;
    el.append(date, count, badge);
    deliveriesList.appendChild(el);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function refreshPoll() {
  const res = await fetch("/api/dashboard/poll");
  if (!res.ok) throw new Error(await readApiError(res, "Failed to load poll."));
  const data = await res.json() as { poll: StructuredPollSummary | null };
  renderPoll(data.poll);
}

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

pollBuilderForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = pollBuilderQuestion.value.trim();
  const options = pollBuilderOptions.value
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);
  if (!question || options.length === 0) return;

  pollBuilderSubmit.disabled = true;
  pollBuilderSubmit.textContent = "Creating…";
  setMsg(pollMsg, "", "");

  try {
    const res = await fetch("/api/dashboard/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, options }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res, "Failed to create poll."));
    }
    pollBuilderQuestion.value = "";
    pollBuilderOptions.value = "";
    await refreshPoll();
    setMsg(pollMsg, "Poll created successfully.", "success");
  } catch (err) {
    setMsg(
      pollMsg,
      err instanceof Error && err.message ? err.message : "Failed to create poll.",
      "error",
    );
  } finally {
    pollBuilderSubmit.disabled = false;
    pollBuilderSubmit.textContent = "Create poll";
  }
});

pollCloseBtn.addEventListener("click", async () => {
  if (!currentPoll) return;
  pollCloseBtn.disabled = true;
  setMsg(pollMsg, "", "");
  try {
    const res = await fetch("/api/dashboard/poll/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollId: currentPoll.id }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res, "Failed to close poll."));
    }
    await refreshPoll();
    setMsg(pollMsg, "Poll closed.", "success");
  } catch (err) {
    setMsg(
      pollMsg,
      err instanceof Error && err.message ? err.message : "Failed to close poll.",
      "error",
    );
  } finally {
    pollCloseBtn.disabled = false;
  }
});

pollDeleteBtn.addEventListener("click", async () => {
  if (!currentPoll) return;
  if (!confirm("Delete this poll and all anonymous responses?")) return;
  pollDeleteBtn.disabled = true;
  setMsg(pollMsg, "", "");
  try {
    const res = await fetch("/api/dashboard/poll", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollId: currentPoll.id }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res, "Failed to delete poll."));
    }
    await refreshPoll();
    setMsg(pollMsg, "Poll deleted.", "success");
  } catch (err) {
    setMsg(
      pollMsg,
      err instanceof Error && err.message ? err.message : "Failed to delete poll.",
      "error",
    );
  } finally {
    pollDeleteBtn.disabled = false;
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

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown };
    return typeof data.error === "string" && data.error.trim() ? data.error : fallback;
  } catch {
    return fallback;
  }
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
