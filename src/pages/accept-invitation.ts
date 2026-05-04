import { authClient } from "../client/auth-client";

const params = new URLSearchParams(location.search);
const invitationId = params.get("id");

// ── State management ──────────────────────────────────────────────────────────

const states = ["loading", "accepting", "success", "error"] as const;
type State = (typeof states)[number];

function show(state: State) {
  for (const s of states) {
    const el = document.getElementById(`state-${s}`)!;
    el.style.display = s === state ? "block" : "none";
  }
}

function setError(message: string) {
  document.getElementById("error-msg")!.textContent = message;
  show("error");
}

// ── Main flow ─────────────────────────────────────────────────────────────────

show("loading");

(async () => {
  if (!invitationId) {
    setError("This invitation link is missing an ID. Please use the link from your email.");
    return;
  }

  const session = await authClient.getSession();

  if (!session?.data?.user) {
    // Not signed in — send to sign-in page, preserving this URL as the redirect target
    const here = `/accept-invitation?id=${encodeURIComponent(invitationId)}`;
    window.location.replace(`/signin?redirect=${encodeURIComponent(here)}`);
    return;
  }

  // Signed in — accept the invitation
  show("accepting");

  try {
    const { data, error } = await authClient.$fetch<{
      invitation: { organizationId: string };
      member: { role: string };
    }>("/organization/accept-invitation", {
      method: "POST",
      body: { invitationId },
    });

    if (error) {
      const msg = (error as { message?: string }).message ?? "";
      if (msg.includes("RECIPIENT")) {
        setError(
          `This invitation was sent to a different address. You are signed in as ${session.data.user.email}.`,
        );
      } else if (msg.includes("EXPIRED") || msg.includes("NOT_FOUND")) {
        setError("This invitation has expired or has already been used.");
      } else {
        setError(msg || "Failed to accept the invitation. Please contact your admin.");
      }
      return;
    }

    if (data?.member?.role) {
      document.getElementById("success-msg")!.textContent =
        `You've joined the organization as ${data.member.role}. You can now submit and view feedback.`;
    }
    show("success");
  } catch {
    setError("Something went wrong. Please try again or contact your admin.");
  }
})();
