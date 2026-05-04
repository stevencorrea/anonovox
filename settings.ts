import { authClient } from "./auth-client";

type Member = {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  user: { name: string; email: string };
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  inviter: { name: string; email: string };
};
type Org = {
  id: string;
  name: string;
  slug: string;
  members: Member[];
  invitations: Invitation[];
};

let currentOrg: Org | null = null;
let currentUserId: string | null = null;
let currentRole: string | null = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const orgNameEl = document.getElementById("org-name") as HTMLElement;
const orgDomainEl = document.getElementById("org-domain") as HTMLElement;
const memberCountEl = document.getElementById("member-count") as HTMLElement;
const membersBody = document.getElementById("members-body") as HTMLTableSectionElement;
const inviteForm = document.getElementById("invite-form") as HTMLFormElement;
const inviteEmailEl = document.getElementById("invite-email") as HTMLInputElement;
const inviteRoleEl = document.getElementById("invite-role") as HTMLSelectElement;
const inviteMsg = document.getElementById("invite-msg") as HTMLElement;
const invitationsSection = document.getElementById("invitations-section") as HTMLElement;
const invitationsList = document.getElementById("invitations-list") as HTMLElement;
const renameForm = document.getElementById("rename-form") as HTMLFormElement;
const renameInput = document.getElementById("rename-input") as HTMLInputElement;
const renameMsg = document.getElementById("rename-msg") as HTMLElement;
const loadingEl = document.getElementById("settings-loading") as HTMLElement;
const contentEl = document.getElementById("settings-content") as HTMLElement;
const noOrgEl = document.getElementById("no-org") as HTMLElement;
const integrationsCard = document.getElementById("integrations-card") as HTMLElement;
const slackDisconnectedEl = document.getElementById("slack-disconnected") as HTMLElement;
const slackConnectedEl = document.getElementById("slack-connected") as HTMLElement;
const slackLoadingEl = document.getElementById("slack-loading") as HTMLElement;
const slackTeamNameEl = document.getElementById("slack-team-name") as HTMLElement;
const slackDisconnectBtn = document.getElementById("slack-disconnect-btn") as HTMLButtonElement;
const slackMsg = document.getElementById("slack-msg") as HTMLElement;
const teamsLoadingEl = document.getElementById("teams-loading") as HTMLElement;
const teamsConnectedSsoEl = document.getElementById("teams-connected-sso") as HTMLElement;
const teamsConnectedManualEl = document.getElementById("teams-connected-manual") as HTMLElement;
const teamsDisconnectedEl = document.getElementById("teams-disconnected") as HTMLElement;
const teamsTenantIdSsoEl = document.getElementById("teams-tenant-id-sso") as HTMLElement;
const teamsTenantIdManualEl = document.getElementById("teams-tenant-id-manual") as HTMLElement;
const teamsDisconnectBtn = document.getElementById("teams-disconnect-btn") as HTMLButtonElement;
const teamsLinkForm = document.getElementById("teams-link-form") as HTMLFormElement;
const teamsTenantInput = document.getElementById("teams-tenant-input") as HTMLInputElement;
const teamsMsg = document.getElementById("teams-msg") as HTMLElement;
const teamsRuntimeDetailsEl = document.getElementById("teams-runtime-details") as HTMLElement;
const teamsRuntimeMissingEl = document.getElementById("teams-runtime-missing") as HTMLElement;
const teamsAppIdEl = document.getElementById("teams-app-id") as HTMLElement;
const teamsMessagingEndpointEl = document.getElementById("teams-messaging-endpoint") as HTMLElement;
const teamsPackageLink = document.getElementById("teams-package-link") as HTMLAnchorElement;
const ssoCard = document.getElementById("sso-card") as HTMLElement;
const ssoTenantDisplay = document.getElementById("sso-tenant-display") as HTMLElement;
const ssoTenantValue = document.getElementById("sso-tenant-value") as HTMLElement;
const ssoClearBtn = document.getElementById("sso-clear-btn") as HTMLButtonElement;
const ssoForm = document.getElementById("sso-form") as HTMLFormElement;
const ssoTenantInput = document.getElementById("sso-tenant-input") as HTMLInputElement;
const ssoMsg = document.getElementById("sso-msg") as HTMLElement;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  const session = await authClient.getSession();
  if (!session?.data?.user) {
    window.location.href = "/signin";
    return;
  }
  currentUserId = session.data.user.id;

  try {
    // 1. Get org ID + role for current user (custom endpoint, domain-based)
    const meRes = await fetch("/api/org/me");
    if (!meRes.ok) throw new Error("Failed to load org info");
    const me = await meRes.json() as { orgId: string | null; role: string | null };

    if (!me.orgId) {
      loadingEl.style.display = "none";
      noOrgEl.style.display = "block";
      return;
    }

    currentRole = me.role;

    // 2. Activate the org in the session (required by getFullOrganization)
    await authClient.$fetch("/organization/set-active", {
      method: "POST",
      body: { organizationId: me.orgId },
    });

    // 3. Load the full org (members, invitations)
    const org = await loadOrg();
    if (!org) {
      loadingEl.style.display = "none";
      noOrgEl.style.display = "block";
      return;
    }

    currentOrg = org;
    render();

    // 4. Load admin-only cards (SSO + integrations)
    if (currentRole === "owner" || currentRole === "admin") {
      ssoCard.style.display = "block";
      loadSsoTenant();
      integrationsCard.style.display = "block";
      loadSlackStatus();
      loadTeamsStatus();
    }

    // Handle redirect back from Slack OAuth
    const slackParam = new URLSearchParams(location.search).get("slack");
    if (slackParam === "connected") {
      setMsg(slackMsg, "Slack connected successfully.", "success");
      history.replaceState({}, "", "/settings");
    } else if (slackParam === "error") {
      setMsg(slackMsg, "Failed to connect Slack. Please try again.", "error");
      history.replaceState({}, "", "/settings");
    }

    loadingEl.style.display = "none";
    contentEl.style.display = "block";
  } catch (err) {
    console.error("Settings load error:", err);
    loadingEl.textContent = "Failed to load settings.";
  }
})();

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadOrg(): Promise<Org | null> {
  const res = await authClient.$fetch<Org>("/organization/get-full-organization");
  return (res.data as Org) ?? null;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  if (!currentOrg) return;
  const isAdmin = currentRole === "owner" || currentRole === "admin";

  orgNameEl.textContent = currentOrg.name;
  orgDomainEl.textContent = `@${currentOrg.slug}`;
  memberCountEl.textContent = String(currentOrg.members?.length ?? 0);
  renameInput.value = currentOrg.name;
  renameForm.style.display = isAdmin ? "flex" : "none";

  // Render members
  membersBody.replaceChildren();
  for (const m of currentOrg.members ?? []) {
    const isSelf = m.userId === currentUserId;
    const isOwner = m.role === "owner";
    const row = document.createElement("tr");
    const identityCell = document.createElement("td");
    const name = document.createElement("div");
    name.className = "member-name";
    name.textContent = m.user?.name ?? "";
    const email = document.createElement("div");
    email.className = "member-email";
    email.textContent = m.user?.email ?? "";
    identityCell.append(name, email);

    const roleCell = document.createElement("td");
    const roleBadge = document.createElement("span");
    const safeRole = normalizeRole(m.role);
    roleBadge.className = `role-badge role-${safeRole}`;
    roleBadge.textContent = safeRole;
    roleCell.appendChild(roleBadge);

    const joinedCell = document.createElement("td");
    joinedCell.className = "member-joined";
    joinedCell.textContent = formatDate(m.createdAt);

    const actionCell = document.createElement("td");
    actionCell.style.textAlign = "right";
    if (isAdmin && !isSelf && !isOwner) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-remove";
      removeBtn.textContent = "Remove";
      removeBtn.dataset.memberId = m.id;
      removeBtn.dataset.memberEmail = m.user?.email ?? "";
      actionCell.appendChild(removeBtn);
    } else {
      const noAction = document.createElement("span");
      noAction.className = "member-no-action";
      noAction.textContent = "—";
      actionCell.appendChild(noAction);
    }

    row.append(identityCell, roleCell, joinedCell, actionCell);
    membersBody.appendChild(row);
  }
  membersBody.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const memberId = (btn as HTMLElement).dataset.memberId!;
      const email = (btn as HTMLElement).dataset.memberEmail!;
      removeMember(memberId, email);
    });
  });

  // Render pending invitations
  const pending = (currentOrg.invitations ?? []).filter((i) => i.status === "pending");
  if (pending.length > 0) {
    invitationsSection.style.display = "block";
    invitationsList.replaceChildren();
    for (const inv of pending) {
      const row = document.createElement("div");
      row.className = "invitation-row";
      const email = document.createElement("span");
      email.className = "invitation-email";
      email.textContent = inv.email;
      const role = document.createElement("span");
      const safeRole = normalizeRole(inv.role);
      role.className = `role-badge role-${safeRole}`;
      role.textContent = safeRole;
      const expiry = document.createElement("span");
      expiry.className = "invitation-expiry";
      expiry.textContent = `Expires ${formatDate(inv.expiresAt)}`;
      row.append(email, role, expiry);
      if (isAdmin) {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn-cancel-invite";
        cancelBtn.textContent = "Cancel";
        cancelBtn.dataset.inviteId = inv.id;
        row.appendChild(cancelBtn);
      }
      invitationsList.appendChild(row);
    }
    invitationsSection.querySelectorAll(".btn-cancel-invite").forEach((btn) => {
      btn.addEventListener("click", () =>
        cancelInvitation((btn as HTMLElement).dataset.inviteId!),
      );
    });
  } else {
    invitationsSection.style.display = "none";
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

inviteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentOrg) return;
  const email = inviteEmailEl.value.trim();
  const role = inviteRoleEl.value;
  if (!email) return;

  setMsg(inviteMsg, "", "");
  const submitBtn = inviteForm.querySelector("button[type='submit']") as HTMLButtonElement;
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";

  try {
    await authClient.$fetch("/organization/invite-member", {
      method: "POST",
      body: { email, role, organizationId: currentOrg.id },
    });
    inviteEmailEl.value = "";
    setMsg(inviteMsg, `Invitation sent to ${email}.`, "success");
    const updated = await loadOrg();
    if (updated) { currentOrg = updated; render(); }
  } catch {
    setMsg(inviteMsg, "Failed to send invitation. Check the email and try again.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send invite";
  }
});

renameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentOrg) return;
  const name = renameInput.value.trim();
  if (!name || name === currentOrg.name) return;

  const submitBtn = renameForm.querySelector("button[type='submit']") as HTMLButtonElement;
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  setMsg(renameMsg, "", "");

  try {
    await authClient.$fetch("/organization/update", {
      method: "POST",
      body: { data: { name }, organizationId: currentOrg.id },
    });
    currentOrg.name = name;
    orgNameEl.textContent = name;
    setMsg(renameMsg, "Organization name updated.", "success");
  } catch {
    setMsg(renameMsg, "Failed to update name.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save";
  }
});

async function removeMember(memberId: string, email: string) {
  if (!currentOrg) return;
  if (!confirm(`Remove ${email} from the organization?`)) return;
  try {
    await authClient.$fetch("/organization/remove-member", {
      method: "POST",
      body: { memberIdOrEmail: memberId, organizationId: currentOrg.id },
    });
    const updated = await loadOrg();
    if (updated) { currentOrg = updated; render(); }
  } catch {
    alert("Failed to remove member.");
  }
}

async function cancelInvitation(invitationId: string) {
  if (!currentOrg) return;
  try {
    await authClient.$fetch("/organization/cancel-invitation", {
      method: "POST",
      body: { invitationId },
    });
    const updated = await loadOrg();
    if (updated) { currentOrg = updated; render(); }
  } catch {
    alert("Failed to cancel invitation.");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setMsg(el: HTMLElement, text: string, type: "success" | "error" | "") {
  el.textContent = text;
  el.className = `inline-msg ${type}`;
  el.style.display = text ? "block" : "none";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function normalizeRole(role: string | null | undefined): "owner" | "admin" | "member" {
  if (role === "owner" || role === "admin") return role;
  return "member";
}

// ── Slack integration ─────────────────────────────────────────────────────

async function loadSlackStatus() {
  slackLoadingEl.style.display = "block";
  slackConnectedEl.style.display = "none";
  slackDisconnectedEl.style.display = "none";
  try {
    const res = await fetch("/api/slack/status");
    if (!res.ok) throw new Error("Failed");
    const { connected, teamName } = await res.json() as { connected: boolean; teamName: string | null };
    renderSlackStatus(connected, teamName);
  } catch {
    slackLoadingEl.style.display = "none";
    slackDisconnectedEl.style.display = "block";
  }
}

function renderSlackStatus(connected: boolean, teamName: string | null) {
  slackLoadingEl.style.display = "none";
  if (connected) {
    slackTeamNameEl.textContent = teamName ?? "";
    slackConnectedEl.style.display = "block";
    slackDisconnectedEl.style.display = "none";
  } else {
    slackConnectedEl.style.display = "none";
    slackDisconnectedEl.style.display = "block";
  }
}

slackDisconnectBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect Slack? Members will no longer be able to submit feedback via the /feedback command.")) return;
  slackDisconnectBtn.disabled = true;
  setMsg(slackMsg, "", "");
  try {
    const res = await fetch("/api/slack", { method: "DELETE" });
    if (!res.ok) throw new Error("Failed");
    renderSlackStatus(false, null);
    setMsg(slackMsg, "Slack disconnected.", "success");
  } catch {
    setMsg(slackMsg, "Failed to disconnect. Please try again.", "error");
  } finally {
    slackDisconnectBtn.disabled = false;
  }
});

// ── Teams integration ─────────────────────────────────────────────────────

async function loadTeamsStatus() {
  teamsLoadingEl.style.display = "block";
  teamsConnectedSsoEl.style.display = "none";
  teamsConnectedManualEl.style.display = "none";
  teamsDisconnectedEl.style.display = "none";
  teamsRuntimeDetailsEl.style.display = "none";
  teamsRuntimeMissingEl.style.display = "none";
  try {
    const res = await fetch("/api/teams/status");
    if (!res.ok) throw new Error("Failed");
    const {
      connected,
      tenantId,
      source,
      configured,
      appId,
      messagingEndpoint,
      packageUrl,
    } = await res.json() as {
      connected: boolean;
      tenantId: string | null;
      source: "sso" | "manual" | null;
      configured: boolean;
      appId: string | null;
      messagingEndpoint: string | null;
      packageUrl: string | null;
    };
    renderTeamsStatus(connected, tenantId, source, configured, appId, messagingEndpoint, packageUrl);
  } catch {
    teamsLoadingEl.style.display = "none";
    teamsDisconnectedEl.style.display = "block";
  }
}

function renderTeamsStatus(
  connected: boolean,
  tenantId: string | null,
  source: "sso" | "manual" | null,
  configured: boolean,
  appId: string | null,
  messagingEndpoint: string | null,
  packageUrl: string | null,
) {
  teamsLoadingEl.style.display = "none";
  teamsConnectedSsoEl.style.display = "none";
  teamsConnectedManualEl.style.display = "none";
  teamsDisconnectedEl.style.display = "none";
  teamsRuntimeDetailsEl.style.display = configured ? "block" : "none";
  teamsRuntimeMissingEl.style.display = configured ? "none" : "block";
  teamsLinkForm.style.display = configured ? "block" : "none";

  teamsAppIdEl.textContent = appId ?? "Not configured";
  teamsMessagingEndpointEl.textContent = messagingEndpoint ?? "Not configured";
  teamsPackageLink.href = packageUrl ?? "#";
  teamsPackageLink.style.pointerEvents = configured && packageUrl ? "auto" : "none";
  teamsPackageLink.style.opacity = configured && packageUrl ? "1" : "0.55";

  if (connected && source === "sso") {
    teamsTenantIdSsoEl.textContent = tenantId ?? "";
    teamsConnectedSsoEl.style.display = "block";
  } else if (connected && source === "manual") {
    teamsTenantIdManualEl.textContent = tenantId ?? "";
    teamsConnectedManualEl.style.display = "block";
  } else {
    teamsDisconnectedEl.style.display = "block";
  }
}

teamsLinkForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tenantId = teamsTenantInput.value.trim();
  if (!tenantId) return;

  const submitBtn = teamsLinkForm.querySelector("button[type='submit']") as HTMLButtonElement;
  submitBtn.disabled = true;
  submitBtn.textContent = "Connecting…";
  setMsg(teamsMsg, "", "");

  try {
    const res = await fetch("/api/teams/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    if (!res.ok) throw new Error("Failed");
    await loadTeamsStatus();
    setMsg(teamsMsg, "Teams connected successfully.", "success");
    teamsTenantInput.value = "";
  } catch {
    setMsg(teamsMsg, "Failed to connect. Check the tenant ID and try again.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Connect";
  }
});

teamsDisconnectBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect Teams? Members will no longer be able to submit feedback via the bot.")) return;
  teamsDisconnectBtn.disabled = true;
  setMsg(teamsMsg, "", "");
  try {
    const res = await fetch("/api/teams", { method: "DELETE" });
    if (!res.ok) throw new Error("Failed");
    await loadTeamsStatus();
    setMsg(teamsMsg, "Teams disconnected.", "success");
  } catch {
    setMsg(teamsMsg, "Failed to disconnect. Please try again.", "error");
  } finally {
    teamsDisconnectBtn.disabled = false;
  }
});

// ── Enterprise SSO ────────────────────────────────────────────────────────────

async function loadSsoTenant() {
  try {
    const res = await fetch("/api/org/entra-tenant");
    if (!res.ok) return;
    const { entraTenantId } = await res.json() as { entraTenantId: string | null };
    renderSsoTenant(entraTenantId);
  } catch { /* ignore */ }
}

function renderSsoTenant(tenantId: string | null) {
  if (tenantId) {
    ssoTenantValue.textContent = tenantId;
    ssoTenantDisplay.style.display = "block";
    ssoTenantInput.value = tenantId;
  } else {
    ssoTenantDisplay.style.display = "none";
    ssoTenantInput.value = "";
  }
}

ssoForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tenantId = ssoTenantInput.value.trim();
  if (!tenantId) return;

  const submitBtn = ssoForm.querySelector("button[type='submit']") as HTMLButtonElement;
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  setMsg(ssoMsg, "", "");

  try {
    const res = await fetch("/api/org/entra-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    if (!res.ok) throw new Error("Failed");
    renderSsoTenant(tenantId);
    setMsg(ssoMsg, "Tenant ID saved. Microsoft SSO is now enabled for your organization.", "success");
  } catch {
    setMsg(ssoMsg, "Failed to save tenant ID.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save";
  }
});

ssoClearBtn.addEventListener("click", async () => {
  if (!confirm("Remove the registered Entra tenant? Microsoft SSO will stop working for your organization.")) return;
  ssoClearBtn.disabled = true;
  setMsg(ssoMsg, "", "");
  try {
    const res = await fetch("/api/org/entra-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: null }),
    });
    if (!res.ok) throw new Error("Failed");
    renderSsoTenant(null);
    setMsg(ssoMsg, "Entra tenant removed.", "success");
  } catch {
    setMsg(ssoMsg, "Failed to remove tenant.", "error");
  } finally {
    ssoClearBtn.disabled = false;
  }
});
