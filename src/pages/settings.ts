import { authClient } from "../client/auth-client";

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
  leaderUserIds?: string[];
};

type OrgContext = {
  orgId: string | null;
  role: string | null;
  orgName: string | null;
  orgSlug: string | null;
  plan: string | null;
};

type OrgPlan = "trial" | "pro" | "enterprise";
type SettingsSection = "people" | "billing" | "slack" | "teams" | "entra";

const VALID_SECTIONS: SettingsSection[] = ["people", "billing", "slack", "teams", "entra"];
const ADMIN_SECTIONS = new Set<SettingsSection>(["billing", "slack", "teams", "entra"]);

let currentOrg: Org | null = null;
let currentUserId: string | null = null;
let currentRole: "owner" | "admin" | "member" = "member";
let currentPlan: OrgPlan = "trial";
let currentSection: SettingsSection = "people";

const orgNameEl = document.getElementById("org-name") as HTMLElement;
const orgDomainEl = document.getElementById("org-domain") as HTMLElement;
const memberCountEl = document.getElementById("member-count") as HTMLElement;
const membersBody = document.getElementById("members-body") as HTMLTableSectionElement;
const inviteForm = document.getElementById("invite-form") as HTMLFormElement;
const inviteEmailEl = document.getElementById("invite-email") as HTMLInputElement;
const inviteRoleEl = document.getElementById("invite-role") as HTMLSelectElement;
const inviteMsg = document.getElementById("invite-msg") as HTMLElement;
const leaderMsg = document.getElementById("leader-msg") as HTMLElement;
const leaderSummaryEl = document.getElementById("leader-summary") as HTMLElement;
const inviteDomainHint = document.getElementById("invite-domain-hint") as HTMLElement;
const invitationsSection = document.getElementById("invitations-section") as HTMLElement;
const invitationsList = document.getElementById("invitations-list") as HTMLElement;
const renameForm = document.getElementById("rename-form") as HTMLFormElement;
const renameInput = document.getElementById("rename-input") as HTMLInputElement;
const renameMsg = document.getElementById("rename-msg") as HTMLElement;
const loadingEl = document.getElementById("settings-loading") as HTMLElement;
const contentEl = document.getElementById("settings-content") as HTMLElement;
const noOrgEl = document.getElementById("no-org") as HTMLElement;

const sidebarOrgName = document.getElementById("sidebar-org-name") as HTMLElement;
const sidebarOrgDomain = document.getElementById("sidebar-org-domain") as HTMLElement;
const sidebarSummary = document.getElementById("sidebar-summary") as HTMLElement;
const orgPlanBadge = document.getElementById("org-plan-badge") as HTMLElement;
const currentRoleBadge = document.getElementById("current-role-badge") as HTMLElement;

const sectionLinks = Array.from(document.querySelectorAll<HTMLElement>("[data-section-link]"));
const sectionPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-section-panel]"));
const adminOnlyElements = Array.from(document.querySelectorAll<HTMLElement>("[data-admin-only]"));

const billingPlanName = document.getElementById("billing-plan-name") as HTMLElement;
const billingPlanCaption = document.getElementById("billing-plan-caption") as HTMLElement;
const billingPlanNote = document.getElementById("billing-plan-note") as HTMLElement;
const billingFeatureList = document.getElementById("billing-feature-list") as HTMLElement;
const billingPrimaryLink = document.getElementById("billing-primary-link") as HTMLAnchorElement;
const billingSecondaryLink = document.getElementById("billing-secondary-link") as HTMLAnchorElement;

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

const entraUpgradeCard = document.getElementById("entra-upgrade-card") as HTMLElement;
const ssoCard = document.getElementById("sso-card") as HTMLElement;
const ssoTenantDisplay = document.getElementById("sso-tenant-display") as HTMLElement;
const ssoTenantValue = document.getElementById("sso-tenant-value") as HTMLElement;
const ssoClearBtn = document.getElementById("sso-clear-btn") as HTMLButtonElement;
const ssoForm = document.getElementById("sso-form") as HTMLFormElement;
const ssoTenantInput = document.getElementById("sso-tenant-input") as HTMLInputElement;
const ssoMsg = document.getElementById("sso-msg") as HTMLElement;

setupSectionNavigation();

(async () => {
  const session = await authClient.getSession();
  if (!session?.data?.user) {
    window.location.href = "/signin";
    return;
  }
  currentUserId = session.data.user.id;

  try {
    const meRes = await fetch("/api/org/me");
    if (!meRes.ok) {
      loadingEl.textContent = await readApiError(meRes, "Failed to load organization settings.");
      return;
    }

    const me = await meRes.json() as OrgContext;
    if (!me.orgId) {
      loadingEl.style.display = "none";
      noOrgEl.style.display = "block";
      return;
    }

    currentRole = normalizeRole(me.role);
    currentPlan = normalizePlan(me.plan);

    await authClient.$fetch("/organization/set-active", {
      method: "POST",
      body: { organizationId: me.orgId },
    });

    const org = await loadOrg();
    if (!org) {
      loadingEl.style.display = "none";
      noOrgEl.style.display = "block";
      return;
    }

    currentOrg = org;
    currentOrg.leaderUserIds = await loadLeaderUserIds();
    renderWorkspaceChrome();
    renderPeople();
    renderBilling();
    renderSectionAvailability();
    applySection(resolveRequestedSection(), true);

    if (isOrgAdmin()) {
      void loadSlackStatus();
      void loadTeamsStatus();
      void loadSsoTenant();
    }

    const slackParam = new URLSearchParams(location.search).get("slack");
    if (slackParam === "connected") {
      setMsg(slackMsg, "Slack connected successfully.", "success");
      history.replaceState({}, "", buildSettingsUrl(currentSection));
    } else if (slackParam === "claimed") {
      setMsg(slackMsg, "This Slack workspace is already connected to another organization.", "error");
      history.replaceState({}, "", buildSettingsUrl(currentSection));
    } else if (slackParam === "error") {
      setMsg(slackMsg, "Failed to connect Slack. Please try again.", "error");
      history.replaceState({}, "", buildSettingsUrl(currentSection));
    }

    loadingEl.style.display = "none";
    contentEl.style.display = "block";
  } catch (err) {
    console.error("Settings load error:", err);
    loadingEl.textContent = "Failed to load settings.";
  }
})();

window.addEventListener("popstate", () => {
  applySection(resolveRequestedSection(), true);
});

async function loadOrg(): Promise<Org | null> {
  const res = await authClient.$fetch<Org>("/organization/get-full-organization");
  if (res && typeof res === "object" && "data" in res) {
    return ((res as { data?: Org }).data ?? null);
  }
  return (res as Org) ?? null;
}

async function loadLeaderUserIds(): Promise<string[]> {
  const res = await fetch("/api/org/leader-role");
  if (!res.ok) {
    throw new Error(await readApiError(res, "Failed to load leader role assignments."));
  }
  const payload = await res.json() as { leaderUserIds?: string[] };
  return Array.isArray(payload.leaderUserIds)
    ? payload.leaderUserIds.filter((item): item is string => typeof item === "string")
    : [];
}

async function refreshOrgState(options: { renderWorkspaceChrome?: boolean } = {}) {
  const updated = await loadOrg();
  if (!updated) return;
  currentOrg = updated;
  currentOrg.leaderUserIds = await loadLeaderUserIds();
  if (options.renderWorkspaceChrome) {
    renderWorkspaceChrome();
  }
  renderPeople();
}

function renderWorkspaceChrome() {
  if (!currentOrg) return;

  orgPlanBadge.textContent = planLabel(currentPlan);

  const safeRole = normalizeRole(currentRole);
  currentRoleBadge.className = `role-badge role-${safeRole}`;
  currentRoleBadge.textContent = safeRole;

  sidebarOrgName.textContent = currentOrg.name;
  sidebarOrgDomain.textContent = `Workspace domain: @${currentOrg.slug}`;
  sidebarSummary.textContent = isOrgAdmin()
    ? "Use the sections below to manage members, billing, and workplace integrations."
    : "You can view your workspace membership here. Administrative changes are limited to owners and admins.";
}

function renderPeople() {
  if (!currentOrg) return;
  const leaderUserIds = new Set(currentOrg.leaderUserIds ?? []);
  const leaderCount = leaderUserIds.size;

  orgNameEl.textContent = currentOrg.name;
  orgDomainEl.textContent = `@${currentOrg.slug}`;
  memberCountEl.textContent = String(currentOrg.members?.length ?? 0);
  leaderSummaryEl.textContent = leaderCount > 0
    ? `${leaderCount} member${leaderCount === 1 ? "" : "s"} currently receive the monthly leadership digest.`
    : "No members are assigned the leader role yet.";
  renameInput.value = currentOrg.name;
  renameForm.style.display = isOrgAdmin() ? "flex" : "none";
  inviteForm.style.display = isOrgAdmin() ? "block" : "none";
  inviteRoleEl.parentElement?.parentElement?.style.setProperty("display", isOwner() ? "block" : "none");
  inviteDomainHint.textContent = `Invitations are restricted to @${currentOrg.slug}.`;
  inviteEmailEl.placeholder = `colleague@${currentOrg.slug}`;

  membersBody.replaceChildren();
  for (const member of currentOrg.members ?? []) {
    const isSelf = member.userId === currentUserId;
    const isOwnerRole = member.role === "owner";
    const row = document.createElement("tr");

    const identityCell = document.createElement("td");
    const name = document.createElement("div");
    name.className = "member-name";
    name.textContent = member.user?.name ?? "";
    const email = document.createElement("div");
    email.className = "member-email";
    email.textContent = member.user?.email ?? "";
    identityCell.append(name, email);

    const roleCell = document.createElement("td");
    const roleBadge = document.createElement("span");
    const safeRole = normalizeRole(member.role);
    roleBadge.className = `role-badge role-${safeRole}`;
    roleBadge.textContent = safeRole;
    roleCell.appendChild(roleBadge);

    const leaderCell = document.createElement("td");
    const leaderStack = document.createElement("div");
    leaderStack.className = "member-role-stack";
    const isLeader = leaderUserIds.has(member.userId);
    const leaderBadge = document.createElement("span");
    leaderBadge.className = `role-badge ${isLeader ? "role-leader" : "role-muted"}`;
    leaderBadge.textContent = isLeader ? "leader" : "not assigned";
    leaderStack.appendChild(leaderBadge);
    leaderCell.appendChild(leaderStack);

    const joinedCell = document.createElement("td");
    joinedCell.className = "member-joined";
    joinedCell.textContent = formatDate(member.createdAt);

    const actionCell = document.createElement("td");
    actionCell.style.textAlign = "right";
    const actionStack = document.createElement("div");
    actionStack.className = "member-actions";
    if (isOrgAdmin()) {
      const leaderBtn = document.createElement("button");
      leaderBtn.className = "btn-role-toggle";
      leaderBtn.textContent = isLeader ? "Remove leader" : "Add leader";
      leaderBtn.dataset.userId = member.userId;
      leaderBtn.dataset.memberEmail = member.user?.email ?? "";
      leaderBtn.dataset.enabled = String(!isLeader);
      actionStack.appendChild(leaderBtn);
    }
    if (isOrgAdmin() && !isSelf && !isOwnerRole) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-remove";
      removeBtn.textContent = "Remove";
      removeBtn.dataset.memberId = member.id;
      removeBtn.dataset.memberEmail = member.user?.email ?? "";
      actionStack.appendChild(removeBtn);
    }
    if (actionStack.childElementCount > 0) {
      actionCell.appendChild(actionStack);
    } else {
      const noAction = document.createElement("span");
      noAction.className = "member-no-action";
      noAction.textContent = "—";
      actionCell.appendChild(noAction);
    }

    row.append(identityCell, roleCell, leaderCell, joinedCell, actionCell);
    membersBody.appendChild(row);
  }

  membersBody.querySelectorAll<HTMLButtonElement>(".btn-role-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const userId = btn.dataset.userId!;
      const email = btn.dataset.memberEmail!;
      const enabled = btn.dataset.enabled === "true";
      void toggleLeaderRole(userId, enabled, email);
    });
  });

  membersBody.querySelectorAll<HTMLButtonElement>(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const memberId = btn.dataset.memberId!;
      const email = btn.dataset.memberEmail!;
      void removeMember(memberId, email);
    });
  });

  const pending = (currentOrg.invitations ?? []).filter((invitation) => invitation.status === "pending");
  if (pending.length > 0) {
    invitationsSection.style.display = "block";
    invitationsList.replaceChildren();
    for (const invitation of pending) {
      const row = document.createElement("div");
      row.className = "invitation-row";

      const email = document.createElement("span");
      email.className = "invitation-email";
      email.textContent = invitation.email;

      const role = document.createElement("span");
      const safeRole = normalizeRole(invitation.role);
      role.className = `role-badge role-${safeRole}`;
      role.textContent = safeRole;

      const expiry = document.createElement("span");
      expiry.className = "invitation-expiry";
      expiry.textContent = `Expires ${formatDate(invitation.expiresAt)}`;
      row.append(email, role, expiry);

      if (isOrgAdmin()) {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn-cancel-invite";
        cancelBtn.textContent = "Cancel";
        cancelBtn.dataset.inviteId = invitation.id;
        row.appendChild(cancelBtn);
      }
      invitationsList.appendChild(row);
    }

    invitationsList.querySelectorAll<HTMLButtonElement>(".btn-cancel-invite").forEach((btn) => {
      btn.addEventListener("click", () => {
        void cancelInvitation(btn.dataset.inviteId!);
      });
    });
  } else {
    invitationsSection.style.display = "none";
  }
}

function renderBilling() {
  const plan = currentPlan;
  const featureSets: Record<OrgPlan, string[]> = {
    trial: [
      "Anonymous feedback collection for a small team",
      "Guaranteed leadership delivery and visible responses",
      "A lightweight starting point while you evaluate the workflow",
    ],
    pro: [
      "Unlimited users and more room to scale engagement",
      "Richer operational reporting and stronger leadership routing controls",
      "A stronger day-to-day admin surface for growing organizations",
    ],
    enterprise: [
      "Microsoft Entra ID sign-in and directory-backed provisioning",
      "Enterprise identity controls with tenant-based access management",
      "Dedicated rollout support for complex organizations",
    ],
  };

  const captions: Record<OrgPlan, string> = {
    trial: "This workspace is currently on the Trial plan.",
    pro: "This workspace is currently on the Pro plan.",
    enterprise: "This workspace is currently on the Enterprise plan.",
  };

  const notes: Record<OrgPlan, string> = {
    trial: "Upgrade when you need richer admin tooling or identity integrations.",
    pro: "Move to Enterprise when you need Microsoft tenant-backed sign-in and provisioning.",
    enterprise: "Your workspace already has access to the deepest admin and identity controls.",
  };

  billingPlanName.textContent = planLabel(plan);
  billingPlanCaption.textContent = captions[plan];
  billingPlanNote.textContent = notes[plan];
  billingFeatureList.replaceChildren(
    ...featureSets[plan].map((feature) => {
      const item = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "feature-dot";
      const text = document.createElement("span");
      text.textContent = feature;
      item.append(dot, text);
      return item;
    }),
  );

  if (plan === "enterprise") {
    billingPrimaryLink.textContent = "Contact support";
    billingPrimaryLink.href = "mailto:enterprise@anonovox.com";
    billingSecondaryLink.textContent = "Review pricing";
    billingSecondaryLink.href = "/pricing";
  } else if (plan === "pro") {
    billingPrimaryLink.textContent = "Review Enterprise";
    billingPrimaryLink.href = "/pricing";
    billingSecondaryLink.textContent = "Talk to sales";
    billingSecondaryLink.href = "mailto:enterprise@anonovox.com";
  } else {
    billingPrimaryLink.textContent = "Compare plans";
    billingPrimaryLink.href = "/pricing";
    billingSecondaryLink.textContent = "Talk to sales";
    billingSecondaryLink.href = "mailto:enterprise@anonovox.com";
  }

  renderSsoPlanState();
}

function renderSectionAvailability() {
  const showAdmin = isOrgAdmin();
  adminOnlyElements.forEach((element) => {
    element.style.display = showAdmin ? "" : "none";
  });
}

function resolveRequestedSection(): SettingsSection {
  const requested = new URLSearchParams(window.location.search).get("section");
  const normalized = VALID_SECTIONS.find((section) => section === requested) ?? "people";
  if (!isOrgAdmin() && ADMIN_SECTIONS.has(normalized)) {
    return "people";
  }
  return normalized;
}

function applySection(section: SettingsSection, replaceHistory: boolean) {
  currentSection = section;

  sectionLinks.forEach((link) => {
    const linkSection = link.dataset.section as SettingsSection | undefined;
    link.classList.toggle("active", linkSection === section);
  });

  sectionPanels.forEach((panel) => {
    const panelSection = panel.dataset.sectionPanel as SettingsSection | undefined;
    panel.classList.toggle("active", panelSection === section);
  });

  const targetUrl = buildSettingsUrl(section);
  if (replaceHistory) {
    history.replaceState({}, "", targetUrl);
  } else {
    history.pushState({}, "", targetUrl);
  }
}

function setupSectionNavigation() {
  sectionLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const requested = link.dataset.section as SettingsSection | undefined;
      if (!requested) return;
      if (!isOrgAdmin() && ADMIN_SECTIONS.has(requested)) return;
      applySection(requested, false);
    });
  });
}

function buildSettingsUrl(section: SettingsSection): string {
  return `/settings?section=${section}`;
}

inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentOrg || !isOrgAdmin()) return;

  const email = inviteEmailEl.value.trim().toLowerCase();
  const role = isOwner() ? inviteRoleEl.value : "member";
  const requiredDomain = currentOrg.slug.toLowerCase();

  if (!email) return;
  if (!email.endsWith(`@${requiredDomain}`)) {
    setMsg(inviteMsg, `Invitations are limited to @${requiredDomain}.`, "error");
    return;
  }

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
    await refreshOrgState();
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : "Failed to send invitation. Check the email and try again.";
    setMsg(inviteMsg, message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send invite";
  }
});

renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentOrg || !isOrgAdmin()) return;
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
    renderWorkspaceChrome();
    renderPeople();
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
    await refreshOrgState({ renderWorkspaceChrome: true });
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
    await refreshOrgState();
  } catch {
    alert("Failed to cancel invitation.");
  }
}

async function toggleLeaderRole(userId: string, enabled: boolean, email: string) {
  if (!currentOrg || !isOrgAdmin()) return;

  setMsg(leaderMsg, "", "");
  try {
    const res = await fetch("/api/org/leader-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, enabled }),
    });
    if (!res.ok) {
      throw new Error(await readApiError(res, "Failed to update leader role."));
    }

    const payload = await res.json() as { leaderUserIds?: string[] };
    currentOrg.leaderUserIds = Array.isArray(payload.leaderUserIds)
      ? payload.leaderUserIds.filter((item): item is string => typeof item === "string")
      : [];
    renderPeople();
    setMsg(
      leaderMsg,
      enabled
        ? `${email} will receive future monthly digests.`
        : `${email} will no longer receive future monthly digests.`,
      "success",
    );
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to update leader role.";
    setMsg(leaderMsg, message, "error");
  }
}

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
  if (!confirm("Disconnect Slack? Members will no longer be able to submit feedback via /feedback.")) return;
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
    const payload = await res.json() as {
      connected: boolean;
      tenantId: string | null;
      source: "sso" | "manual" | null;
      configured: boolean;
      appId: string | null;
      messagingEndpoint: string | null;
      packageUrl: string | null;
    };
    renderTeamsStatus(
      payload.connected,
      payload.tenantId,
      payload.source,
      payload.configured,
      payload.appId,
      payload.messagingEndpoint,
      payload.packageUrl,
    );
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

teamsLinkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
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
    if (!res.ok) {
      throw new Error(await readApiError(res, "Failed to connect. Check the tenant ID and try again."));
    }
    await loadTeamsStatus();
    setMsg(teamsMsg, "Teams connected successfully.", "success");
    teamsTenantInput.value = "";
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : "Failed to connect. Check the tenant ID and try again.";
    setMsg(teamsMsg, message, "error");
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

async function loadSsoTenant() {
  try {
    const res = await fetch("/api/org/entra-tenant");
    if (!res.ok) return;
    const { entraTenantId } = await res.json() as { entraTenantId: string | null };
    renderSsoTenant(entraTenantId);
  } catch {
    // ignore
  }
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

function renderSsoPlanState() {
  if (!isOrgAdmin()) {
    entraUpgradeCard.style.display = "none";
    ssoCard.style.display = "none";
    return;
  }

  if (currentPlan === "enterprise") {
    entraUpgradeCard.style.display = "none";
    ssoCard.style.display = "block";
  } else {
    entraUpgradeCard.style.display = "block";
    ssoCard.style.display = "none";
  }
}

ssoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentPlan !== "enterprise") return;
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
    if (!res.ok) throw new Error(await readApiError(res, "Failed to save tenant ID."));
    renderSsoTenant(tenantId);
    setMsg(ssoMsg, "Tenant ID saved. Microsoft SSO is now enabled for your organization.", "success");
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to save tenant ID.";
    setMsg(ssoMsg, message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save";
  }
});

ssoClearBtn.addEventListener("click", async () => {
  if (currentPlan !== "enterprise") return;
  if (!confirm("Remove the registered Entra tenant? Microsoft SSO will stop working for your organization.")) return;
  ssoClearBtn.disabled = true;
  setMsg(ssoMsg, "", "");
  try {
    const res = await fetch("/api/org/entra-tenant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: null }),
    });
    if (!res.ok) throw new Error(await readApiError(res, "Failed to remove tenant."));
    renderSsoTenant(null);
    setMsg(ssoMsg, "Entra tenant removed.", "success");
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Failed to remove tenant.";
    setMsg(ssoMsg, message, "error");
  } finally {
    ssoClearBtn.disabled = false;
  }
});

function isOrgAdmin(): boolean {
  return currentRole === "owner" || currentRole === "admin";
}

function isOwner(): boolean {
  return currentRole === "owner";
}

function normalizePlan(plan: string | null | undefined): OrgPlan {
  if (plan === "pro" || plan === "enterprise") return plan;
  return "trial";
}

function normalizeRole(role: string | null | undefined): "owner" | "admin" | "member" {
  if (role === "owner" || role === "admin") return role;
  return "member";
}

function planLabel(plan: OrgPlan): string {
  switch (plan) {
    case "enterprise":
      return "Enterprise";
    case "pro":
      return "Pro";
    default:
      return "Trial";
  }
}

function setMsg(el: HTMLElement, text: string, type: "success" | "error" | "") {
  el.textContent = text;
  el.className = `inline-msg ${type}`;
  el.style.display = text ? "block" : "none";
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json() as { error?: unknown; message?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
    if (typeof data.message === "string" && data.message.trim()) return data.message;
    return fallback;
  } catch {
    return fallback;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
