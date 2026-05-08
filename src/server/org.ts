import { auth } from "./auth";
import { sql } from "./db";

export const LEADER_ROLE = "leader";

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "aol.com",
  "protonmail.com",
]);

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function getEmailDomain(email: string): string | null {
  const domain = email.split("@")[1];
  return domain ? normalizeDomain(domain) : null;
}

function formatOrgName(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return (base.charAt(0).toUpperCase() + base.slice(1)).replace(/-/g, " ");
}

export async function getOrgByDomain(domain: string) {
  const normalizedDomain = normalizeDomain(domain);
  const rows =
    await sql`SELECT id, name, slug, "entraTenantId" FROM "organization" WHERE slug = ${normalizedDomain} LIMIT 1`;
  return (rows[0] as { id: string; name: string; slug: string; entraTenantId: string | null }) ?? null;
}

type EntraMembershipRow = {
  memberId: string;
  role: string;
  organizationId: string;
  entraTenantId: string | null;
  memberCreatedAt: string;
};

export async function ensureOrgMembership(user: {
  id: string;
  email: string;
}) {
  const domain = getEmailDomain(user.email);
  if (!domain || PERSONAL_DOMAINS.has(domain)) return;

  const org = await getOrgByDomain(domain);
  if (!org) {
    const orgId = crypto.randomUUID();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${orgId}, ${formatOrgName(domain)}, ${domain}, NOW())
    `;
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${crypto.randomUUID()}, ${orgId}, ${user.id}, 'owner', NOW())
    `;
    await logSsoEvent("org_provisioned", user.id, orgId, { domain });
  } else {
    const existing =
      await sql`SELECT id FROM "member" WHERE "organizationId" = ${org.id} AND "userId" = ${user.id}`;
    if (!existing.length) {
      // If a pending invitation exists for this user+org, don't auto-add them as 'member'.
      // The correct role will be applied when they accept the invitation.
      const pending = await sql`
        SELECT id FROM "invitation"
        WHERE email = ${user.email}
          AND "organizationId" = ${org.id}
          AND status = 'pending'
          AND "expiresAt" > NOW()
        LIMIT 1
      `;
      if (pending.length > 0) return;

      await sql`
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
        VALUES (${crypto.randomUUID()}, ${org.id}, ${user.id}, 'member', NOW())
      `;
    }
  }
}

// Parses Entra roles from a stored idToken (JWT payload — no signature verification
// needed here since Better Auth already verified the token during sign-in).
function decodeJwtPayload(idToken: string): Record<string, unknown> {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return {};
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"));
  } catch {
    return {};
  }
}

// Checks whether the Entra roles array from the idToken includes any of the
// configured admin role/group IDs from ENTRA_ADMIN_ROLE_IDS (comma-separated).
function isEntraAdmin(entraRoles: string[]): boolean {
  const adminIds = (process.env.ENTRA_ADMIN_ROLE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!adminIds.length) return false;
  return entraRoles.some((r) => adminIds.includes(r));
}

function getClaimStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

// Called from auth.ts account.create.after hook for Microsoft SSO sign-ins.
// Decodes the idToken, determines the anonovox role from Entra claims, updates
// the member table, and optionally stores the Entra tenant ID on the org.
export async function handleEntraAccountCreated(account: {
  userId: string;
  providerId: string;
  idToken: string | null | undefined;
}) {
  if (account.providerId !== "microsoft" || !account.idToken) return;

  const claims = decodeJwtPayload(account.idToken);
  const entraRoles = getClaimStrings(claims.roles);
  const entraGroups = getClaimStrings(claims.groups);
  const allClaims = [...entraRoles, ...entraGroups];
  const tid = typeof claims.tid === "string" ? claims.tid : undefined;

  const memberRows = await sql`
    SELECT
      m.id AS "memberId",
      m.role,
      m."organizationId",
      o."entraTenantId",
      m."createdAt" AS "memberCreatedAt"
    FROM "member" m
    JOIN "organization" o ON o.id = m."organizationId"
    WHERE m."userId" = ${account.userId}
  ` as EntraMembershipRow[];
  const membership = selectEntraMembership(memberRows, null, tid);
  if (!membership) {
    await logSsoEvent("sso_membership_ambiguous", account.userId, null, {
      tid,
      membershipCount: memberRows.length,
      source: "entra_signup",
    });
    return;
  }

  const {
    memberId,
    role: currentRole,
    organizationId: orgId,
    entraTenantId: registeredTid,
  } = membership;

  // If the org has a registered tenant, the login's tid must match.
  if (registeredTid && tid && registeredTid !== tid) {
    await logSsoEvent("sso_tenant_mismatch", account.userId, orgId, {
      expected: registeredTid,
      received: tid,
    });
    return;
  }

  // Store the Entra tenant ID on the org if not already set.
  if (tid && !registeredTid) {
    await sql`
      UPDATE "organization" SET "entraTenantId" = ${tid}
      WHERE id = ${orgId}
    `;
  }

  // Only upgrade/set role for non-owners; owners keep their role regardless.
  if (currentRole !== "owner") {
    const targetRole = isEntraAdmin(allClaims) ? "admin" : "member";
    if (targetRole !== currentRole) {
      await sql`UPDATE "member" SET role = ${targetRole} WHERE id = ${memberId}`;
      await logSsoEvent("role_assigned", account.userId, orgId, {
        from: currentRole,
        to: targetRole,
        source: "entra_claims",
      });
    }
  }

  await logSsoEvent("sso_signup", account.userId, orgId, {
    tid,
    roleCount: allClaims.length,
  });
}

// Called from auth.ts account.update.after hook for subsequent Microsoft logins.
export async function handleEntraAccountUpdated(account: {
  userId: string;
  providerId: string;
  idToken: string | null | undefined;
}) {
  if (account.providerId !== "microsoft" || !account.idToken) return;

  const claims = decodeJwtPayload(account.idToken);
  const entraRoles = getClaimStrings(claims.roles);
  const entraGroups = getClaimStrings(claims.groups);
  const allClaims = [...entraRoles, ...entraGroups];
  const tid = typeof claims.tid === "string" ? claims.tid : undefined;

  const memberRows = await sql`
    SELECT
      m.id AS "memberId",
      m.role,
      m."organizationId",
      o."entraTenantId",
      m."createdAt" AS "memberCreatedAt"
    FROM "member" m
    JOIN "organization" o ON o.id = m."organizationId"
    WHERE m."userId" = ${account.userId}
  ` as EntraMembershipRow[];
  const membership = selectEntraMembership(memberRows, null, tid);
  if (!membership) {
    await logSsoEvent("sso_membership_ambiguous", account.userId, null, {
      tid,
      membershipCount: memberRows.length,
      source: "entra_login",
    });
    return;
  }

  const {
    memberId,
    role: currentRole,
    organizationId: orgId,
    entraTenantId: registeredTid,
  } = membership;

  if (registeredTid && tid && registeredTid !== tid) {
    await logSsoEvent("sso_tenant_mismatch", account.userId, orgId, {
      expected: registeredTid,
      received: tid,
    });
    return;
  }

  if (tid && !registeredTid) {
    await sql`
      UPDATE "organization" SET "entraTenantId" = ${tid}
      WHERE id = ${orgId}
    `;
  }

  if (currentRole !== "owner") {
    const targetRole = isEntraAdmin(allClaims) ? "admin" : "member";
    if (targetRole !== currentRole) {
      await sql`UPDATE "member" SET role = ${targetRole} WHERE id = ${memberId}`;
      await logSsoEvent("role_assigned", account.userId, orgId, {
        from: currentRole,
        to: targetRole,
        source: "entra_claims_refresh",
      });
    }
  }

  await logSsoEvent("sso_login", account.userId, orgId, {
    roleCount: allClaims.length,
  });
}

export async function logSsoEvent(
  event: string,
  userId: string | null,
  orgId: string | null,
  metadata: Record<string, unknown> = {},
) {
  try {
    await sql`
      INSERT INTO private.sso_audit_log (event, user_id, org_id, metadata)
      VALUES (${event}, ${userId}, ${orgId}, ${JSON.stringify(metadata)}::jsonb)
    `;
  } catch (err) {
    console.error("[sso_audit_log] Failed to write event:", event, err);
  }
}

export async function setOrgEntraTenant(orgId: string, tenantId: string | null) {
  await sql`UPDATE "organization" SET "entraTenantId" = ${tenantId} WHERE id = ${orgId}`;
}

export async function listOrgRoleUserIds(orgId: string, role: string): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT assignment.user_id
    FROM private.org_role_assignments assignment
    JOIN "member" m
      ON m."organizationId" = assignment.org_id
     AND m."userId" = assignment.user_id
    WHERE assignment.org_id = ${orgId}
      AND assignment.role = ${role}
  ` as Array<{ user_id: string }>;

  return rows.map((row) => row.user_id);
}

export async function listOrgLeaderUserIds(orgId: string): Promise<string[]> {
  return listOrgRoleUserIds(orgId, LEADER_ROLE);
}

export async function setOrgLeaderRole(params: {
  orgId: string;
  userId: string;
  enabled: boolean;
  assignedBy: string;
}) {
  const { orgId, userId, enabled, assignedBy } = params;
  const membershipRows = await sql`
    SELECT id
    FROM "member"
    WHERE "organizationId" = ${orgId}
      AND "userId" = ${userId}
    LIMIT 1
  `;

  if (!membershipRows[0]) {
    throw new Error("Member not found in this organization");
  }

  if (enabled) {
    await sql`
      INSERT INTO private.org_role_assignments (org_id, user_id, role, assigned_by)
      VALUES (${orgId}, ${userId}, ${LEADER_ROLE}, ${assignedBy})
      ON CONFLICT (org_id, user_id, role) DO UPDATE
      SET assigned_by = EXCLUDED.assigned_by
    `;
    return;
  }

  await sql`
    DELETE FROM private.org_role_assignments
    WHERE org_id = ${orgId}
      AND user_id = ${userId}
      AND role = ${LEADER_ROLE}
  `;
}

export async function listOrgLeaderRecipients(orgId: string): Promise<Array<{ email: string; name: string }>> {
  const rows = await sql`
    SELECT DISTINCT u.email, u.name
    FROM private.org_role_assignments assignment
    JOIN "member" m
      ON m."organizationId" = assignment.org_id
     AND m."userId" = assignment.user_id
    JOIN "user" u ON u.id = assignment.user_id
    WHERE assignment.org_id = ${orgId}
      AND assignment.role = ${LEADER_ROLE}
      AND u.email IS NOT NULL
    ORDER BY u.email ASC
  ` as Array<{ email: string; name: string }>;

  return rows;
}

type SessionData = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
type OrgRecord = {
  id: string;
  name: string;
  slug: string;
  entraTenantId: string | null;
  plan: string | null;
};
type OrgMembershipRow = OrgRecord & { role: string; memberCreatedAt: string };

function getActiveOrganizationId(session: SessionData): string | null {
  const activeOrganizationId =
    (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  return typeof activeOrganizationId === "string" && activeOrganizationId.trim()
    ? activeOrganizationId
    : null;
}

function rolePriority(role: string): number {
  switch (role) {
    case "owner":
      return 0;
    case "admin":
      return 1;
    case "member":
      return 2;
    default:
      return 3;
  }
}

function selectPreferredMembership<T extends { role: string; memberCreatedAt: string }>(
  memberships: T[],
): T | null {
  const [preferred] = [...memberships].sort((a, b) => {
    const roleDelta = rolePriority(a.role) - rolePriority(b.role);
    if (roleDelta !== 0) return roleDelta;
    return new Date(a.memberCreatedAt).getTime() - new Date(b.memberCreatedAt).getTime();
  });

  return preferred ?? null;
}

function selectSessionMembership(
  memberships: OrgMembershipRow[],
  activeOrganizationId: string | null,
): OrgMembershipRow | null {
  if (!memberships.length) return null;

  const activeMembership = activeOrganizationId
    ? memberships.find((membership) => membership.id === activeOrganizationId)
    : null;
  if (activeMembership) return activeMembership;

  if (memberships.length === 1) return memberships[0] ?? null;

  return selectPreferredMembership(memberships);
}

function selectEntraMembership(
  memberships: EntraMembershipRow[],
  activeOrganizationId: string | null,
  tenantId: string | undefined,
): EntraMembershipRow | null {
  if (!memberships.length) return null;

  const activeMembership = activeOrganizationId
    ? memberships.find((membership) => membership.organizationId === activeOrganizationId)
    : null;

  if (tenantId) {
    const matchingTenantMemberships = memberships.filter((membership) => membership.entraTenantId === tenantId);
    if (matchingTenantMemberships.length > 0) {
      return selectPreferredMembership(matchingTenantMemberships);
    }

    if (activeMembership && (!activeMembership.entraTenantId || activeMembership.entraTenantId === tenantId)) {
      return activeMembership;
    }

    const unboundMemberships = memberships.filter((membership) => !membership.entraTenantId);
    if (unboundMemberships.length === 1) return unboundMemberships[0] ?? null;

    return null;
  }

  if (activeMembership) return activeMembership;
  if (memberships.length === 1) return memberships[0] ?? null;

  return selectPreferredMembership(memberships);
}

function unauthorizedResponse() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function verifiedEmailRequiredResponse() {
  return Response.json({ error: "Verified email required" }, { status: 403 });
}

export async function requireVerifiedSession(req: Request): Promise<SessionData | Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return unauthorizedResponse();
  if (!session.user.emailVerified) return verifiedEmailRequiredResponse();
  return session;
}

export async function getSessionOrgMembership(
  session: SessionData,
): Promise<{ org: OrgRecord; role: string } | null> {
  const memberships = await sql`
    SELECT
      o.id,
      o.name,
      o.slug,
      o."entraTenantId",
      o.plan,
      m.role,
      m."createdAt" AS "memberCreatedAt"
    FROM "member" m
    JOIN "organization" o ON o.id = m."organizationId"
    WHERE m."userId" = ${session.user.id}
  ` as OrgMembershipRow[];

  if (!memberships.length) return null;

  const fallbackMembership = selectSessionMembership(
    memberships,
    getActiveOrganizationId(session),
  );
  if (!fallbackMembership) return null;

  const { role, memberCreatedAt: _memberCreatedAt, ...org } = fallbackMembership;
  return { org, role };
}

const STAFF_DOMAIN = process.env.STAFF_EMAIL_DOMAIN ?? "anonovox.com";

export async function requireStaffSession(req: Request): Promise<SessionData | Response> {
  const session = await requireVerifiedSession(req);
  if (session instanceof Response) return session;
  const domain = getEmailDomain(session.user.email);
  if (domain !== STAFF_DOMAIN) {
    return Response.json({ error: "Staff access required" }, { status: 403 });
  }
  return session;
}

type AdminCheckResult =
  | { session: SessionData; org: OrgRecord; role: "owner" | "admin" }
  | Response;

export async function requireOrgAdmin(req: Request): Promise<AdminCheckResult> {
  const session = await requireVerifiedSession(req);
  if (session instanceof Response) return session;

  const membership = await getSessionOrgMembership(session);
  if (!membership) return Response.json({ error: "No organization found" }, { status: 403 });

  if (!["owner", "admin"].includes(membership.role)) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }

  return { session, org: membership.org, role: membership.role as "owner" | "admin" };
}
