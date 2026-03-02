import { authClient } from "./auth-client";

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

function setMode(m: Mode) {
  mode = m;
  if (mode === "signin") {
    formTitle.textContent    = "Welcome back.";
    formSubtitle.textContent = "Sign in to submit and view feedback.";
    submitLabel.textContent  = "Sign in";
    toggleText.innerHTML     = `No account? <button class="toggle-btn" id="toggle-btn">Create one.</button>`;
  } else {
    formTitle.textContent    = "Create your account.";
    formSubtitle.textContent = "Your email domain identifies your organization.";
    submitLabel.textContent  = "Create account";
    toggleText.innerHTML     = `Already have one? <button class="toggle-btn" id="toggle-btn">Sign in.</button>`;
  }
  document.getElementById("toggle-btn")!.addEventListener("click", () => {
    setMode(mode === "signin" ? "signup" : "signin");
  });
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
      window.location.href = "/feedback";
    }
  } else {
    const name = email.split("@")[0];
    const { error } = await authClient.signUp.email({ email, password, name });
    if (error) {
      showMessage(error.message ?? "Sign up failed. Please try again.", "error");
      submitBtn.disabled = false;
    } else {
      window.location.href = "/feedback";
    }
  }
});
