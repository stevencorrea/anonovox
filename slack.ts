import { createHmac, timingSafeEqual } from "node:crypto";

// ── Slack request signature verification ──────────────────────────────────
// Slack signs every inbound request with HMAC-SHA256 using SLACK_SIGNING_SECRET.
// We also enforce a 5-minute timestamp window to prevent replay attacks.

export async function verifySlackSignature(
  headers: Headers,
  rawBody: string,
): Promise<boolean> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return false;

  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const computed = `v0=${createHmac("sha256", signingSecret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;

  const a = Buffer.from(computed);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── OAuth state signing (CSRF prevention) ─────────────────────────────────
// state = `${orgId}:${issuedAtBase36}:${hmac(orgId:issuedAt, BETTER_AUTH_SECRET)}`

const STATE_TTL_MS = 15 * 60 * 1000;

function getStateSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required for Slack OAuth state signing");
  }
  return secret;
}

function stateHmac(orgId: string, issuedAt: string): string {
  return createHmac("sha256", getStateSecret())
    .update(`${orgId}:${issuedAt}`)
    .digest("hex");
}

export function signState(orgId: string): string {
  const issuedAt = Date.now().toString(36);
  return `${orgId}:${issuedAt}:${stateHmac(orgId, issuedAt)}`;
}

export function verifyState(state: string): string | null {
  const [orgId, issuedAt, provided] = state.split(":");
  if (!orgId || !issuedAt || !provided) return null;
  const issuedAtMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedAtMs)) return null;
  if (Date.now() - issuedAtMs > STATE_TTL_MS || issuedAtMs > Date.now() + 60_000) {
    return null;
  }

  const expected = stateHmac(orgId, issuedAt);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return null;
  return orgId;
}

// ── DB helpers ─────────────────────────────────────────────────────────────

export async function getSlackWorkspace(
  teamId: string,
): Promise<{ orgId: string; orgSlug: string } | null> {
  const rows = await Bun.sql`
    SELECT sw.org_id, o.slug AS org_slug
    FROM integration.slack_workspaces sw
    JOIN "organization" o ON o.id = sw.org_id
    WHERE sw.slack_workspace_id = ${teamId}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return { orgId: rows[0].org_id, orgSlug: rows[0].org_slug };
}

export async function saveSlackWorkspace(
  orgId: string,
  teamId: string,
  teamName: string,
  accessToken: string,
  installedBy: string | null,
): Promise<void> {
  await Bun.sql`
    INSERT INTO integration.slack_workspaces
      (org_id, slack_workspace_id, team_name, access_token, installed_by)
    VALUES (${orgId}, ${teamId}, ${teamName}, ${accessToken}, ${installedBy})
    ON CONFLICT (slack_workspace_id) DO UPDATE
      SET org_id       = EXCLUDED.org_id,
          team_name    = EXCLUDED.team_name,
          access_token = EXCLUDED.access_token,
          installed_by = EXCLUDED.installed_by,
          installed_at = NOW()
  `;
}

export async function deleteSlackWorkspace(orgId: string): Promise<void> {
  await Bun.sql`DELETE FROM integration.slack_workspaces WHERE org_id = ${orgId}`;
}

export async function getSlackConnectionByOrg(
  orgId: string,
): Promise<{ teamId: string; teamName: string } | null> {
  const rows = await Bun.sql`
    SELECT slack_workspace_id AS team_id, team_name
    FROM integration.slack_workspaces
    WHERE org_id = ${orgId}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return { teamId: rows[0].team_id, teamName: rows[0].team_name ?? "" };
}
