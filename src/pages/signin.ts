import { authClient } from "../client/auth-client";

// Redirect if already signed in
const { data: session } = await authClient.getSession();
if (session) window.location.replace("/feedback");

type Mode = "signin" | "signup";
let mode: Mode = "signin";

const formTitle    = document.getElementById("form-title")!;
const formSubtitle = document.getElementById("form-subtitle")!;
const submitLabel  = document.getElementById("submit-label")!;
const toggleText   = document.getElementById("toggle-text")!;
const form         = document.getElementById("auth-form") as HTMLFormElement;
const emailInput   = document.getElementById("email") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const submitBtn    = document.getElementById("submit-btn") as HTMLButtonElement;
const messageEl    = document.getElementById("message")!;

function renderTogglePrompt(prompt: string, buttonLabel: string) {
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "toggle-btn";
  toggleBtn.id = "toggle-btn";
  toggleBtn.type = "button";
  toggleBtn.textContent = buttonLabel;
  toggleBtn.addEventListener("click", () => {
    setMode(mode === "signin" ? "signup" : "signin");
  });
  toggleText.replaceChildren(prompt, " ", toggleBtn);
}

function renderMicrosoftButton() {
  microsoftBtn.replaceChildren(
    createMicrosoftIcon(),
    document.createTextNode(" Sign in with Microsoft"),
  );
}

function createMicrosoftIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 21 21");
  svg.setAttribute("fill", "none");

  for (const [x, y, fill] of [
    ["1", "1", "#F25022"],
    ["11", "1", "#7FBA00"],
    ["1", "11", "#00A4EF"],
    ["11", "11", "#FFB900"],
  ] as const) {
    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", "9");
    rect.setAttribute("height", "9");
    rect.setAttribute("fill", fill);
    svg.appendChild(rect);
  }

  return svg;
}

function setMode(m: Mode) {
  mode = m;
  if (mode === "signin") {
    formTitle.textContent    = "Welcome back.";
    formSubtitle.textContent = "Sign in to submit and view feedback.";
    submitLabel.textContent  = "Sign in";
    renderTogglePrompt("No account?", "Create one.");
  } else {
    formTitle.textContent    = "Create your account.";
    formSubtitle.textContent = "Your email domain identifies your organization.";
    submitLabel.textContent  = "Create account";
    renderTogglePrompt("Already have one?", "Sign in.");
  }
  hideMessage();
}

function showMessage(text: string, type: "success" | "error") {
  messageEl.textContent  = text;
  messageEl.className    = `message ${type}`;
  messageEl.style.display = "block";
}

function hideMessage() {
  messageEl.style.display = "none";
}

setMode("signin");

// Show org name as user types their email
const domainHint = document.getElementById("domain-hint")!;
emailInput.addEventListener("input", () => {
  const at = emailInput.value.indexOf("@");
  const domain = at > -1 ? emailInput.value.slice(at + 1) : "";
  if (domain) {
    const span = document.createElement("span");
    span.textContent = domain;
    domainHint.replaceChildren("Organization: ", span);
  } else {
    domainHint.replaceChildren();
  }
});

// Only allow same-origin redirects (must start with /)
function safeRedirect(): string {
  const redirect = new URLSearchParams(location.search).get("redirect") ?? "";
  return redirect.startsWith("/") ? redirect : "/feedback";
}

const microsoftBtn = document.getElementById("microsoft-btn") as HTMLButtonElement;
renderMicrosoftButton();
microsoftBtn.addEventListener("click", async () => {
  microsoftBtn.disabled = true;
  microsoftBtn.textContent = "Redirecting…";
  hideMessage();
  const { data, error } = await authClient.signIn.social({
    provider: "microsoft",
    callbackURL: safeRedirect(),
    errorCallbackURL: "/signin",
  });
  if (error || !data?.url) {
    showMessage(error?.message ?? "Microsoft sign-in unavailable.", "error");
    microsoftBtn.disabled = false;
    renderMicrosoftButton();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email    = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) return;

  submitBtn.disabled = true;
  hideMessage();

  if (mode === "signin") {
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      showMessage(error.message ?? "Sign in failed. Please try again.", "error");
      submitBtn.disabled = false;
    } else {
      window.location.href = safeRedirect();
    }
  } else {
    const name = email.split("@")[0] ?? email;
    const { error } = await authClient.signUp.email({ email, password, name });
    if (error) {
      showMessage(error.message ?? "Sign up failed. Please try again.", "error");
      submitBtn.disabled = false;
    } else {
      window.location.href = safeRedirect();
    }
  }
});
