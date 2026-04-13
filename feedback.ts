import type { AnalysisRisk } from "./analyze";

const form = document.getElementById("feedback-form") as HTMLFormElement;
const messageEl = document.getElementById("message") as HTMLDivElement;
const submitBtn = form.querySelector("button[type='submit']") as HTMLButtonElement;
const textarea = document.getElementById("feedback") as HTMLTextAreaElement;
const suggestionsPanel = document.getElementById("suggestions-panel") as HTMLDivElement;
const suggestionsList = document.getElementById("suggestions-list") as HTMLDivElement;

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
      showMessage("Your feedback has been received. It will be included in the next batch.", "success");
    } else if (res.status === 401) {
      showMessage("You must be signed in to submit feedback.", "error");
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

// --- Debounced analysis ---

let abortController: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const dismissed = new Set<string>();

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
  suggestionsList.innerHTML = "";

  if (risks.length === 0) {
    hideSuggestions();
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
