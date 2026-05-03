// Microsoft Teams bot integration.
//
// Auth model: the Bot Framework signs every inbound request with a JWT issued
// by Microsoft's dedicated Bot Framework tenant. We verify that JWT using their
// public JWKS, check the audience matches our app ID, then trust the activity.
//
// Org mapping: check organization.entraTenantId first (free for SSO users),
// fall back to integration.teams_tenants for orgs that linked manually.

export interface TeamsActivity {
  type: string;
  id: string;
  text?: string;
  from: { id: string; name?: string };
  conversation: { id: string; isGroup?: boolean };
  recipient: { id: string };
  serviceUrl: string;
  channelId: string;
  channelData?: { tenant?: { id: string } };
}

// ── JWKS / JWT verification ────────────────────────────────────────────────
// Bot Framework tokens are signed by Microsoft's dedicated BF tenant.
// Keys rotate infrequently — cache for 24 h.

const BF_JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";

const BF_TRUSTED_ISSUERS = new Set([
  "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
  "https://login.microsoftonline.com/d6d49420-f39b-4df7-a1dc-d59a935871db/v2.0",
]);

// Allowed Bot Framework service URL hosts (SSRF guard)
const BF_ALLOWED_HOSTS = new Set(["smba.trafficmanager.net"]);
const BF_ALLOWED_SUFFIXES = [".botframework.com"];

type Jwk = { kid: string; [key: string]: unknown };

let jwksCache: { kidMap: Record<string, CryptoKey>; expiresAt: number } | null = null;

async function getCachedKey(kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  if (!jwksCache || jwksCache.expiresAt < now) {
    const res = await fetch(BF_JWKS_URL);
    const { keys } = (await res.json()) as { keys: Jwk[] };
    const kidMap: Record<string, CryptoKey> = {};
    await Promise.all(
      keys.map(async (jwk) => {
        try {
          kidMap[jwk.kid] = await crypto.subtle.importKey(
            "jwk",
            jwk as unknown as JsonWebKey,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
        } catch { /* skip keys that fail to import */ }
      }),
    );
    jwksCache = { kidMap, expiresAt: now + 24 * 60 * 60 * 1000 };
  }
  return jwksCache.kidMap[kid] ?? null;
}

export async function verifyBotToken(authHeader: string | null): Promise<boolean> {
  const appId = process.env.TEAMS_APP_ID ?? process.env.MICROSOFT_CLIENT_ID;
  if (!appId || !authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { kid?: string; alg?: string };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      iss?: string; aud?: string; exp?: number; nbf?: number;
    };

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) return false;
    if (payload.nbf && now < payload.nbf) return false;
    if (!payload.iss || !BF_TRUSTED_ISSUERS.has(payload.iss)) return false;
    if (payload.aud !== appId) return false;
    if (!header.kid) return false;

    const key = await getCachedKey(header.kid);
    if (!key) return false;

    const encoder = new TextEncoder();
    const sig = new Uint8Array(Buffer.from(parts[2], "base64url"));
    const data = encoder.encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data);
  } catch {
    return false;
  }
}

// ── Bot access token (for sending replies) ────────────────────────────────
// Bot authenticates against the Bot Framework tenant to get a connector token.

let botTokenCache: { token: string; expiresAt: number } | null = null;

async function getBotAccessToken(): Promise<string> {
  const now = Date.now();
  if (botTokenCache && botTokenCache.expiresAt > now + 60_000) return botTokenCache.token;

  const appId = process.env.TEAMS_APP_ID ?? process.env.MICROSOFT_CLIENT_ID;
  const appSecret = process.env.TEAMS_APP_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET;

  const res = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId!,
        client_secret: appSecret!,
        scope: "https://api.botframework.com/.default",
      }),
    },
  );

  const data = (await res.json()) as { access_token: string; expires_in: number };
  botTokenCache = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return botTokenCache.token;
}

function isAllowedServiceUrl(serviceUrl: string): boolean {
  try {
    const url = new URL(serviceUrl);
    if (url.protocol !== "https:") return false;
    if (BF_ALLOWED_HOSTS.has(url.hostname)) return true;
    return BF_ALLOWED_SUFFIXES.some((s) => url.hostname.endsWith(s));
  } catch {
    return false;
  }
}

export async function sendTeamsReply(activity: TeamsActivity, text: string): Promise<void> {
  if (!isAllowedServiceUrl(activity.serviceUrl)) {
    console.error("[teams] Rejected untrusted serviceUrl:", activity.serviceUrl);
    return;
  }
  try {
    const token = await getBotAccessToken();
    const base = activity.serviceUrl.replace(/\/$/, "");
    await fetch(`${base}/v3/conversations/${encodeURIComponent(activity.conversation.id)}/activities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type: "message", text, replyToId: activity.id }),
    });
  } catch (err) {
    console.error("[teams] Failed to send reply:", err);
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────

// Checks entraTenantId (SSO) first, then manual links in integration.teams_tenants.
export async function getOrgByTenantId(
  tenantId: string,
): Promise<{ orgId: string; orgSlug: string } | null> {
  const rows = await Bun.sql`
    SELECT id AS org_id, slug AS org_slug FROM "organization"
    WHERE "entraTenantId" = ${tenantId}
    UNION
    SELECT o.id AS org_id, o.slug AS org_slug
    FROM "organization" o
    JOIN integration.teams_tenants tt ON tt.org_id = o.id
    WHERE tt.tenant_id = ${tenantId}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return { orgId: rows[0].org_id, orgSlug: rows[0].org_slug };
}

export async function saveTeamsTenant(orgId: string, tenantId: string): Promise<void> {
  await Bun.sql`
    INSERT INTO integration.teams_tenants (org_id, tenant_id)
    VALUES (${orgId}, ${tenantId})
    ON CONFLICT (org_id) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id, linked_at = NOW()
  `;
}

export async function deleteTeamsTenant(orgId: string): Promise<void> {
  await Bun.sql`DELETE FROM integration.teams_tenants WHERE org_id = ${orgId}`;
}

// Returns the Teams tenant ID and whether it came from SSO config or manual link.
export async function getTeamsConnectionByOrg(
  orgId: string,
): Promise<{ tenantId: string; source: "sso" | "manual" } | null> {
  const ssoRows = await Bun.sql`
    SELECT "entraTenantId" FROM "organization"
    WHERE id = ${orgId} AND "entraTenantId" IS NOT NULL
    LIMIT 1
  `;
  if (ssoRows[0]) return { tenantId: ssoRows[0].entraTenantId, source: "sso" };

  const manualRows = await Bun.sql`
    SELECT tenant_id FROM integration.teams_tenants WHERE org_id = ${orgId} LIMIT 1
  `;
  if (manualRows[0]) return { tenantId: manualRows[0].tenant_id, source: "manual" };

  return null;
}
