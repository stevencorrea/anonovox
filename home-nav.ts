import { authClient } from "./auth-client";

// Floating ghost voices in hero
const messages = [
  "The all-hands format hasn't worked for a long time",
  "Engineering and product are more misaligned than anyone admits",
  "Promotions feel arbitrary and unexplained",
  "Remote employees feel increasingly invisible",
  "We're moving too fast without enough clarity",
  "The new strategy wasn't communicated down the chain",
  "Mid-level management is creating real bottlenecks",
  "Leadership doesn't know what's actually happening on the ground",
  "Last quarter's wins were celebrated for the wrong reasons",
  "Nobody actually reads the quarterly feedback surveys",
  "There's a culture of fear around honest upward feedback",
  "The best people are quietly considering leaving",
  "We keep solving the symptom, not the problem",
  "There's a lot of nodding in meetings and venting in Slack",
];

const layer = document.getElementById("voices-layer")!;
messages.forEach((text) => {
  const el = document.createElement("span");
  el.className = "ghost-voice";
  el.textContent = text;
  const left = 3 + Math.random() * 82;
  const top  = 30 + Math.random() * 55;
  const dur  = 20 + Math.random() * 16;
  const delay = -(Math.random() * dur);
  el.style.cssText = `left:${left}%;top:${top}%;animation-duration:${dur}s;animation-delay:${delay}s;`;
  layer.appendChild(el);
});

const navAuth = document.getElementById("nav-auth")!;

const { data: session } = await authClient.getSession();

if (session?.user?.email) {
  const [local, domain] = session.user.email.split("@");

  const domainSpan = document.createElement("span");
  domainSpan.className = "nav-domain";
  domainSpan.textContent = domain ?? "";

  const userSpan = document.createElement("span");
  userSpan.className = "nav-user";
  userSpan.append(`${local}@`, domainSpan);

  const feedbackLink = document.createElement("a");
  feedbackLink.href = "/feedback";
  feedbackLink.className = "nav-link";
  feedbackLink.textContent = "Submit feedback";

  const signOutLink = document.createElement("a");
  signOutLink.href = "#";
  signOutLink.className = "nav-link";
  signOutLink.textContent = "Sign out";
  signOutLink.addEventListener("click", async (e) => {
    e.preventDefault();
    await authClient.signOut();
    window.location.reload();
  });

  navAuth.replaceChildren(userSpan, feedbackLink, signOutLink);
}
