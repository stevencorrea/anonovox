import type { AnalysisRisk } from "../lib/analyze";
import type { ReviewSuggestion } from "../lib/review";
import { authClient } from "../client/auth-client";

type StructuredPoll = {
  id: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  status: "active" | "closed";
  created_at: string;
};

type StructuredPollResponse = {
  optionId: string;
  comment: string | null;
  updated_at: string;
};

// Auth guard — redirect to sign-in if no active session
(async () => {
  const session = await authClient.getSession();
  const user = session?.data?.user;

  if (!user) {
    window.location.replace("/signin");
    return;
  }

  // Show verification banner if email not yet verified
  if (!user.emailVerified) {
    const banner = document.getElementById("verify-banner")!;
    banner.style.display = "flex";
    document.getElementById("resend-verify")!.addEventListener("click", async (e) => {
      e.preventDefault();
      const link = e.currentTarget as HTMLAnchorElement;
      const originalText = link.textContent ?? "Resend verification email";
      link.textContent = "Sending…";
      link.style.pointerEvents = "none";
      try {
        const { error } = await authClient.sendVerificationEmail({
          email: user.email,
          callbackURL: "/feedback",
        });
        if (error) {
          showMessage(error.message ?? "Couldn't send verification email. Please try again.", "error");
          link.textContent = originalText;
          link.style.pointerEvents = "";
          return;
        }
        link.textContent = "Sent! Check your inbox.";
      } catch {
        showMessage("Couldn't send verification email. Please try again.", "error");
        link.textContent = originalText;
        link.style.pointerEvents = "";
      }
    });
  } else {
    void loadStructuredPoll();
  }
})();

const form = document.getElementById("feedback-form") as HTMLFormElement;
const messageEl = document.getElementById("message") as HTMLDivElement;
const submitBtn = form.querySelector(
  "button[type='submit']",
) as HTMLButtonElement;
const reviewBtn = document.getElementById("review-btn") as HTMLButtonElement;
const textarea = document.getElementById("feedback") as HTMLTextAreaElement;
const suggestionsPanel = document.getElementById(
  "suggestions-panel",
) as HTMLDivElement;
const suggestionsList = document.getElementById(
  "suggestions-list",
) as HTMLDivElement;
const reviewPanel = document.getElementById("review-panel") as HTMLDivElement;
const reviewContent = document.getElementById(
  "review-content",
) as HTMLDivElement;
const structuredPollCard = document.getElementById("structured-poll-card") as HTMLDivElement;
const structuredPollForm = document.getElementById("structured-poll-form") as HTMLFormElement;
const structuredPollQuestion = document.getElementById("structured-poll-question") as HTMLDivElement;
const structuredPollMeta = document.getElementById("structured-poll-meta") as HTMLDivElement;
const structuredPollOptions = document.getElementById("structured-poll-options") as HTMLDivElement;
const structuredPollComment = document.getElementById("structured-poll-comment") as HTMLTextAreaElement;
const structuredPollSubmit = document.getElementById("structured-poll-submit") as HTMLButtonElement;
const structuredPollMessage = document.getElementById("structured-poll-message") as HTMLDivElement;
const structuredPollResponseNote = document.getElementById("structured-poll-response-note") as HTMLDivElement;

let activeStructuredPoll: StructuredPoll | null = null;
let myStructuredPollResponse: StructuredPollResponse | null = null;

// --- Form submission (moved from inline script) ---

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = (form.feedback as HTMLTextAreaElement).value.trim();
  if (!feedback) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";
  messageEl.style.display = "none";

  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });

    if (res.ok) {
      form.reset();
      dismissed.clear();
      hideSuggestions();
      hideReview();
      showMessage(
        "Your feedback has been received. It will be included in the next monthly digest.",
        "success",
      );
    } else if (res.status === 401) {
      showMessage("You must be signed in to submit feedback.", "error");
    } else if (res.status === 403) {
      showMessage(
        await readApiError(res, "Verify your email before submitting feedback."),
        "error",
      );
    } else {
      showMessage("Something went wrong. Please try again.", "error");
    }
  } catch {
    showMessage("Could not reach the server. Please try again.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit feedback";
  }
});

function showMessage(text: string, type: "success" | "error") {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.style.display = "block";
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown };
    return typeof data.error === "string" && data.error.trim() ? data.error : fallback;
  } catch {
    return fallback;
  }
}

function setStructuredPollMessage(text: string, type: "success" | "error" | "") {
  structuredPollMessage.textContent = text;
  structuredPollMessage.className = `message ${type}`;
  structuredPollMessage.style.display = text ? "block" : "none";
}

function renderStructuredPollResponseNote() {
  if (!myStructuredPollResponse?.updated_at) {
    structuredPollResponseNote.style.display = "none";
    structuredPollResponseNote.textContent = "";
    return;
  }

  structuredPollResponseNote.style.display = "block";
  structuredPollResponseNote.textContent = `Last updated ${relativeTime(myStructuredPollResponse.updated_at)}`;
}

function renderStructuredPoll() {
  const poll = activeStructuredPoll;
  structuredPollOptions.replaceChildren();

  if (!poll) {
    structuredPollCard.style.display = "none";
    return;
  }

  structuredPollCard.style.display = "block";
  structuredPollQuestion.textContent = poll.question;
  structuredPollMeta.textContent = "Anonymous single-select response";
  structuredPollComment.value = myStructuredPollResponse?.comment ?? "";
  structuredPollSubmit.textContent = myStructuredPollResponse ? "Update poll response" : "Submit poll response";

  for (const option of poll.options) {
    const card = document.createElement("label");
    card.className = "poll-option-card";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "structured-poll-option";
    radio.value = option.id;
    radio.checked = myStructuredPollResponse?.optionId === option.id;

    const text = document.createElement("div");
    text.className = "poll-option-text";
    text.textContent = option.label;

    card.append(radio, text);
    structuredPollOptions.appendChild(card);
  }

  renderStructuredPollResponseNote();
}

async function loadStructuredPoll() {
  try {
    const res = await fetch("/api/feedback/poll");
    if (!res.ok) return;
    const data = await res.json() as {
      poll: StructuredPoll | null;
      myResponse: StructuredPollResponse | null;
    };
    activeStructuredPoll = data.poll;
    myStructuredPollResponse = data.myResponse;
    renderStructuredPoll();
  } catch {
    structuredPollCard.style.display = "none";
  }
}

structuredPollForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeStructuredPoll) return;

  const selected = structuredPollForm.querySelector<HTMLInputElement>("input[name='structured-poll-option']:checked");
  if (!selected) {
    setStructuredPollMessage("Choose an option before submitting.", "error");
    return;
  }

  structuredPollSubmit.disabled = true;
  structuredPollSubmit.textContent = myStructuredPollResponse ? "Updating…" : "Submitting…";
  setStructuredPollMessage("", "");

  try {
    const res = await fetch("/api/feedback/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pollId: activeStructuredPoll.id,
        optionId: selected.value,
        comment: structuredPollComment.value.trim() || null,
      }),
    });

    if (!res.ok) {
      setStructuredPollMessage(
        await readApiError(res, "Failed to submit poll response."),
        "error",
      );
      return;
    }

    const data = await res.json() as { myResponse: StructuredPollResponse | null };
    myStructuredPollResponse = data.myResponse;
    renderStructuredPollResponseNote();
    structuredPollSubmit.textContent = "Update poll response";
    setStructuredPollMessage("Your poll response was recorded anonymously.", "success");
  } catch {
    setStructuredPollMessage("Could not reach the server. Please try again.", "error");
  } finally {
    structuredPollSubmit.disabled = false;
    if (activeStructuredPoll) {
      structuredPollSubmit.textContent = myStructuredPollResponse ? "Update poll response" : "Submit poll response";
    }
  }
});

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

// --- Debounced analysis ---

let abortController: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const dismissed = new Set<string>();
let lastRisks: AnalysisRisk[] = [];

function dismissKey(risk: AnalysisRisk): string {
  return `${risk.type}:${risk.matchedText}`;
}

function triggerAnalysis() {
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(async () => {
    const text = textarea.value;
    if (!text.trim()) {
      hideSuggestions();
      return;
    }

    if (abortController) abortController.abort();
    abortController = new AbortController();

    try {
      const res = await fetch("/api/feedback/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abortController.signal,
      });

      if (!res.ok) return;
      const data = await res.json();
      const risks: AnalysisRisk[] = data.risks.filter(
        (r: AnalysisRisk) => !dismissed.has(dismissKey(r)),
      );
      renderSuggestions(risks);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }, 400);
}

textarea.addEventListener("input", triggerAnalysis);

// --- Suggestion rendering ---

function hideSuggestions() {
  suggestionsPanel.style.display = "none";
  suggestionsList.innerHTML = "";
}

function renderSuggestions(risks: AnalysisRisk[]) {
  lastRisks = risks;
  suggestionsList.innerHTML = "";

  if (risks.length === 0) {
    if (textarea.value.trim()) {
      suggestionsPanel.style.display = "block";
      suggestionsList.innerHTML = `
        <div class="suggestions-clean">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <polyline points="2,8 6,12 14,4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          No anonymity risks detected
        </div>`;
    } else {
      hideSuggestions();
    }
    return;
  }

  suggestionsPanel.style.display = "block";

  for (const risk of risks) {
    const card = document.createElement("div");
    card.className = "suggestion-card";

    const typeBadge = document.createElement("div");
    typeBadge.className = "suggestion-type";
    typeBadge.textContent = risk.type;

    const matchText = document.createElement("div");
    matchText.className = "suggestion-match";
    matchText.textContent = `"${risk.matchedText}"`;

    const label = document.createElement("div");
    label.className = "suggestion-label";
    label.textContent = risk.label;

    const actions = document.createElement("div");
    actions.className = "suggestion-actions";

    const redactBtn = document.createElement("button");
    redactBtn.className = "btn-redact";
    redactBtn.textContent = "Redact";
    redactBtn.type = "button";
    redactBtn.addEventListener("click", () => {
      acceptSuggestion(risk);
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "btn-dismiss";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.type = "button";
    dismissBtn.addEventListener("click", () => {
      dismissed.add(dismissKey(risk));
      card.remove();
      if (suggestionsList.children.length === 0) {
        hideSuggestions();
      }
    });

    actions.appendChild(redactBtn);
    actions.appendChild(dismissBtn);

    card.appendChild(typeBadge);
    card.appendChild(matchText);
    card.appendChild(label);
    card.appendChild(actions);

    suggestionsList.appendChild(card);
  }
}

// --- Accept (redact) ---

function acceptSuggestion(risk: AnalysisRisk) {
  const currentText = textarea.value;
  // Find the matched text at the expected position first, fall back to indexOf
  let start = risk.startIndex;
  let end = risk.endIndex;

  if (currentText.slice(start, end) !== risk.matchedText) {
    // Text has shifted — search for it
    const idx = currentText.indexOf(risk.matchedText);
    if (idx === -1) return; // text no longer present
    start = idx;
    end = idx + risk.matchedText.length;
  }

  textarea.value =
    currentText.slice(0, start) + risk.replacement + currentText.slice(end);

  // Place cursor after the replacement
  const cursorPos = start + risk.replacement.length;
  textarea.setSelectionRange(cursorPos, cursorPos);
  textarea.focus();

  // Re-trigger analysis since indices have shifted
  triggerAnalysis();
}

// --- Review draft (LLM) ---

function hideReview() {
  reviewPanel.style.display = "none";
  reviewContent.innerHTML = "";
}

reviewBtn.addEventListener("click", async () => {
  const text = textarea.value.trim();
  if (!text) return;

  reviewBtn.disabled = true;
  reviewBtn.textContent = "Reviewing…";

  // Show loading state in panel
  reviewPanel.style.display = "block";
  reviewContent.innerHTML =
    '<div class="review-loading"><div class="review-spinner"></div>Analyzing your draft…</div>';

  try {
    const res = await fetch("/api/feedback/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, risks: lastRisks }),
    });

    if (!res.ok) {
      reviewContent.innerHTML =
        '<div class="review-loading">Failed to review draft. Please try again.</div>';
      return;
    }

    const data = await res.json();
    renderReview(data.suggestions, data.overall);
  } catch {
    reviewContent.innerHTML =
      '<div class="review-loading">Could not reach the server. Please try again.</div>';
  } finally {
    reviewBtn.disabled = false;
    reviewBtn.textContent = "Review draft";
  }
});

function renderReview(suggestions: ReviewSuggestion[], overall: string) {
  reviewContent.innerHTML = "";

  if (overall) {
    const overallEl = document.createElement("div");
    overallEl.className = "review-overall";
    overallEl.textContent = overall;
    reviewContent.appendChild(overallEl);
  }

  if (suggestions.length === 0) {
    if (!overall) {
      hideReview();
    }
    return;
  }

  for (const s of suggestions) {
    const card = document.createElement("div");
    card.className = "review-card";

    const category = document.createElement("div");
    category.className = "review-category";
    category.textContent = s.category;

    const original = document.createElement("div");
    original.className = "review-original";
    original.textContent = s.original;

    const suggestion = document.createElement("div");
    suggestion.className = "review-suggestion";
    suggestion.textContent = s.suggestion;

    const explanation = document.createElement("div");
    explanation.className = "review-explanation";
    explanation.textContent = s.explanation;

    const actions = document.createElement("div");
    actions.className = "review-actions";

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn-apply";
    applyBtn.textContent = "Apply";
    applyBtn.type = "button";
    applyBtn.addEventListener("click", () => {
      const applied = applyReviewSuggestion(s);
      if (applied) {
        card.remove();
        if (reviewContent.querySelectorAll(".review-card").length === 0) {
          const overallEl = reviewContent.querySelector(".review-overall");
          if (!overallEl) hideReview();
        }
      } else {
        applyBtn.disabled = true;
        applyBtn.textContent = "Can't apply";
        const err = document.createElement("div");
        err.className = "review-apply-error";
        err.textContent = "Draft changed — re-review to apply.";
        actions.appendChild(err);
      }
    });

    const skipBtn = document.createElement("button");
    skipBtn.className = "btn-dismiss";
    skipBtn.textContent = "Skip";
    skipBtn.type = "button";
    skipBtn.addEventListener("click", () => {
      card.remove();
      if (reviewContent.querySelectorAll(".review-card").length === 0) {
        const overallEl = reviewContent.querySelector(".review-overall");
        if (!overallEl) hideReview();
      }
    });

    actions.appendChild(applyBtn);
    actions.appendChild(skipBtn);

    card.appendChild(category);
    card.appendChild(original);
    card.appendChild(suggestion);
    card.appendChild(explanation);
    card.appendChild(actions);

    reviewContent.appendChild(card);
  }
}

function applyReviewSuggestion(s: ReviewSuggestion): boolean {
  const currentText = textarea.value;
  const idx = currentText.indexOf(s.original);
  if (idx === -1) return false;

  textarea.value =
    currentText.slice(0, idx) +
    s.suggestion +
    currentText.slice(idx + s.original.length);

  const cursorPos = idx + s.suggestion.length;
  textarea.setSelectionRange(cursorPos, cursorPos);
  textarea.focus();

  triggerAnalysis();
  return true;
}
