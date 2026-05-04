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
  action?: string;
  text?: string;
  textFormat?: "plain" | "markdown" | "xml" | string;
  from: { id: string; name?: string };
  conversation: { id: string; isGroup?: boolean };
  recipient: { id: string };
  serviceUrl: string;
  channelId: string;
  entities?: Array<{
    type?: string;
    text?: string;
    mentioned?: { id?: string; name?: string };
  }>;
  channelData?: { tenant?: { id: string } };
}

export interface TeamsRuntimeConfig {
  configured: boolean;
  appId: string | null;
  appName: string;
  messagingEndpoint: string | null;
  packageUrl: string | null;
}

const TEAMS_BRAND = {
  accent: "#6264A7",
  appName: "Anonovox",
  packageName: "com.anonovox.teams",
  shortDescription: "Submit anonymous workplace feedback in Teams.",
  fullDescription:
    "Message the Anonovox bot in Microsoft Teams to submit anonymous workplace feedback for your organization.",
} as const;

function getTeamsAppId(): string | null {
  return process.env.TEAMS_APP_ID ?? process.env.MICROSOFT_CLIENT_ID ?? null;
}

function getTeamsAppSecret(): string | null {
  return process.env.TEAMS_APP_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET ?? null;
}

function getAppBaseUrl(): string | null {
  const baseUrl = process.env.BETTER_AUTH_URL?.trim();
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function getTeamsRuntimeConfig(): TeamsRuntimeConfig {
  const appId = getTeamsAppId();
  const baseUrl = getAppBaseUrl();
  const configured = Boolean(appId && getTeamsAppSecret() && baseUrl);

  return {
    configured,
    appId,
    appName: TEAMS_BRAND.appName,
    messagingEndpoint: baseUrl ? `${baseUrl}/api/teams/message` : null,
    packageUrl: configured ? "/api/teams/package" : null,
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripMentionText(text: string, activity: TeamsActivity): string {
  let cleaned = text;
  const appId = getTeamsAppId();
  const botIds = new Set([appId, activity.recipient.id].filter((value): value is string => Boolean(value)));

  for (const entity of activity.entities ?? []) {
    if (entity.type !== "mention") continue;
    const mentionedId = entity.mentioned?.id;
    if (!mentionedId || !botIds.has(mentionedId)) continue;

    const mentionText = entity.text?.trim();
    if (!mentionText) continue;

    cleaned = cleaned.split(mentionText).join(" ");
  }

  return cleaned.replace(/<at>.*?<\/at>/gi, " ");
}

export function getNormalizedTeamsMessage(activity: TeamsActivity): string {
  const rawText = activity.text ?? "";
  const withoutMentions = stripMentionText(rawText, activity);
  const plainText =
    activity.textFormat === "xml" || /<[^>]+>/.test(withoutMentions)
      ? decodeHtmlEntities(withoutMentions.replace(/<[^>]+>/g, " "))
      : withoutMentions;

  return plainText.replace(/\s+/g, " ").trim();
}

function pngColor(hex: string, alpha = 255): [number, number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    alpha,
  ];
}

function createPng(width: number, height: number, drawPixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y);
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const compressed = Bun.deflateSync(raw);
  const chunks = [
    createPngChunk("IHDR", createPngHeader(width, height)),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", new Uint8Array()),
  ];

  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const totalLength = signature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  out.set(signature, offset);
  offset += signature.length;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createPngHeader(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return header;
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(8 + typeBytes.length + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crc = crc32(joinBytes(typeBytes, data));
  view.setUint32(8 + typeBytes.length + data.length, crc);
  return chunk;
}

function buildTeamsColorIcon(size: number): Uint8Array {
  const background = pngColor(TEAMS_BRAND.accent);
  const white: [number, number, number, number] = [255, 255, 255, 255];

  return createPng(size, size, (x, y) => {
    const inset = Math.floor(size * 0.18);
    const bubbleLeft = inset;
    const bubbleTop = inset;
    const bubbleRight = size - inset;
    const bubbleBottom = size - inset - Math.max(3, Math.floor(size * 0.08));
    const tailHeight = Math.max(3, Math.floor(size * 0.1));
    const radius = Math.max(2, Math.floor(size * 0.08));

    const inBubble =
      x >= bubbleLeft &&
      x < bubbleRight &&
      y >= bubbleTop &&
      y < bubbleBottom &&
      inRoundedRect(x, y, bubbleLeft, bubbleTop, bubbleRight, bubbleBottom, radius);

    const tailCenter = Math.floor(size * 0.56);
    const inTail =
      y >= bubbleBottom - 1 &&
      y <= bubbleBottom + tailHeight &&
      x >= tailCenter - tailHeight &&
      x <= tailCenter &&
      y - bubbleBottom <= x - (tailCenter - tailHeight);

    return inBubble || inTail ? white : background;
  });
}

function buildTeamsOutlineIcon(size: number): Uint8Array {
  const transparent: [number, number, number, number] = [0, 0, 0, 0];
  const white: [number, number, number, number] = [255, 255, 255, 255];

  return createPng(size, size, (x, y) => {
    const inset = Math.floor(size * 0.18);
    const bubbleLeft = inset;
    const bubbleTop = inset;
    const bubbleRight = size - inset;
    const bubbleBottom = size - inset - Math.max(2, Math.floor(size * 0.08));
    const radius = Math.max(2, Math.floor(size * 0.08));
    const thickness = Math.max(2, Math.floor(size * 0.08));

    const onOutline =
      isRoundedRectOutline(x, y, bubbleLeft, bubbleTop, bubbleRight, bubbleBottom, radius, thickness)
      || isTailOutline(x, y, size, bubbleBottom, thickness);

    return onOutline ? white : transparent;
  });
}

function inRoundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
): boolean {
  const innerLeft = left + radius;
  const innerRight = right - radius;
  const innerTop = top + radius;
  const innerBottom = bottom - radius;

  if (x >= innerLeft && x < innerRight && y >= top && y < bottom) return true;
  if (x >= left && x < right && y >= innerTop && y < innerBottom) return true;

  const corners = [
    [innerLeft, innerTop],
    [innerRight - 1, innerTop],
    [innerLeft, innerBottom - 1],
    [innerRight - 1, innerBottom - 1],
  ] as const;

  return corners.some(([cx, cy]) => {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  });
}

function isRoundedRectOutline(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
  thickness: number,
): boolean {
  return (
    inRoundedRect(x, y, left, top, right, bottom, radius)
    && !inRoundedRect(x, y, left + thickness, top + thickness, right - thickness, bottom - thickness, Math.max(0, radius - thickness))
  );
}

function isTailOutline(x: number, y: number, size: number, bubbleBottom: number, thickness: number): boolean {
  const tailHeight = Math.max(2, Math.floor(size * 0.1));
  const tailCenter = Math.floor(size * 0.56);
  const inOuter =
    y >= bubbleBottom - 1 &&
    y <= bubbleBottom + tailHeight &&
    x >= tailCenter - tailHeight &&
    x <= tailCenter &&
    y - bubbleBottom <= x - (tailCenter - tailHeight) + thickness;

  const inInner =
    y >= bubbleBottom + 1 &&
    y <= bubbleBottom + tailHeight - thickness &&
    x >= tailCenter - tailHeight + thickness &&
    x <= tailCenter - thickness &&
    y - bubbleBottom - thickness <= x - (tailCenter - tailHeight);

  return inOuter && !inInner;
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function createZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const now = toDosDateTime(new Date());
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, now.time, true);
    localView.setUint16(12, now.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, now.time, true);
    centralView.setUint16(14, now.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.data.length, true);
    centralView.setUint32(24, file.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, file.data);
    centralParts.push(centralHeader);
    offset += localHeader.length + file.data.length;
  }

  const centralDirectory = joinBytes(...centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return joinBytes(...localParts, centralDirectory, end);
}

export function buildTeamsManifest(): string {
  const config = getTeamsRuntimeConfig();
  if (!config.configured || !config.appId || !config.messagingEndpoint) {
    throw new Error("Teams runtime is not fully configured");
  }

  const baseUrl = new URL(config.messagingEndpoint);
  return JSON.stringify({
    $schema: "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: "1.0.0",
    id: config.appId,
    packageName: TEAMS_BRAND.packageName,
    developer: {
      name: TEAMS_BRAND.appName,
      websiteUrl: baseUrl.origin,
      privacyUrl: baseUrl.origin,
      termsOfUseUrl: baseUrl.origin,
    },
    name: {
      short: TEAMS_BRAND.appName,
      full: `${TEAMS_BRAND.appName} for Microsoft Teams`,
    },
    description: {
      short: TEAMS_BRAND.shortDescription,
      full: TEAMS_BRAND.fullDescription,
    },
    icons: {
      color: "color.png",
      outline: "outline.png",
    },
    accentColor: TEAMS_BRAND.accent,
    bots: [{
      botId: config.appId,
      scopes: ["personal", "team", "groupchat"],
      supportsFiles: false,
      isNotificationOnly: false,
      commandLists: [{
        scopes: ["personal", "team", "groupchat"],
        commands: [{
          title: "feedback",
          description: "Send anonymous feedback to leadership",
        }],
      }],
    }],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [baseUrl.hostname],
  }, null, 2);
}

export function buildTeamsAppPackage(): Uint8Array {
  const manifest = new TextEncoder().encode(buildTeamsManifest());
  const colorIcon = buildTeamsColorIcon(192);
  const outlineIcon = buildTeamsOutlineIcon(32);

  return createZip([
    { name: "manifest.json", data: manifest },
    { name: "color.png", data: colorIcon },
    { name: "outline.png", data: outlineIcon },
  ]);
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
    if (!res.ok) {
      throw new Error(`Failed to fetch Bot Framework keys: ${res.status}`);
    }
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
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return false;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString()) as { kid?: string; alg?: string };
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as {
      iss?: string; aud?: string; exp?: number; nbf?: number;
    };

    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256") return false;
    if (payload.exp && now > payload.exp) return false;
    if (payload.nbf && now < payload.nbf) return false;
    if (!payload.iss || !BF_TRUSTED_ISSUERS.has(payload.iss)) return false;
    if (payload.aud !== appId) return false;
    if (!header.kid) return false;

    const key = await getCachedKey(header.kid);
    if (!key) return false;

    const encoder = new TextEncoder();
    const sig = new Uint8Array(Buffer.from(encodedSignature, "base64url"));
    const data = encoder.encode(`${encodedHeader}.${encodedPayload}`);
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
  if (!appId || !appSecret) {
    throw new Error("Teams bot credentials are not configured");
  }

  const res = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appSecret,
        scope: "https://api.botframework.com/.default",
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch Teams bot token: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  if (!data.access_token || !data.expires_in) {
    throw new Error("Teams bot token response was missing required fields");
  }
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
    const res = await fetch(`${base}/v3/conversations/${encodeURIComponent(activity.conversation.id)}/activities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type: "message", text, replyToId: activity.id }),
    });
    if (!res.ok) {
      throw new Error(`Teams reply failed with status ${res.status}`);
    }
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
