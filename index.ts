import homePage from "./index.html";
import feedbackPage from "./feedback.html";
import signinPage from "./signin.html";
import acceptInvitationPage from "./accept-invitation.html";
import pricingPage from "./pricing.html";
import settingsPage from "./settings.html";
import dashboardPage from "./dashboard.html";
import { auth } from "./auth";
import { runMigrations } from "./migrate";
import { analyzeText } from "./analyze";
import type { AnalysisRisk } from "./analyze";
import { reviewDraft } from "./review";
import { requireOrgAdmin, getOrgByDomain, setOrgEntraTenant } from "./org";
import {
  verifySlackSignature,
  signState,
  verifyState,
  getSlackWorkspace,
  saveSlackWorkspace,
  deleteSlackWorkspace,
  getSlackConnectionByOrg,
} from "./slack";
import {
  verifyBotToken,
  sendTeamsReply,
  getOrgByTenantId,
  saveTeamsTenant,
  deleteTeamsTenant,
  getTeamsConnectionByOrg,
  getTeamsRuntimeConfig,
  getNormalizedTeamsMessage,
  buildTeamsAppPackage,
  type TeamsActivity,
} from "./teams";
import { getCachedInsights, refreshInsights } from "./insights";
import { startScheduler, runBatchJob } from "./scheduler";

const MAX_FEEDBACK_LENGTH = 4_000;
const MAX_PERIOD_LABEL_LENGTH = 120;
const MAX_FEED_LIMIT = 100;
const ENTRA_TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_BASE_URL = process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

function errorResponse(status: number, error: string) {
  return Response.json({ error }, { status });
}

async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function clampInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requireMaxLength(value: string, maxLength: number, fieldName: string): Response | null {
  if (value.length > maxLength) {
    return errorResponse(400, `${fieldName} must be ${maxLength} characters or fewer`);
  }
  return null;
}

function normalizeTenantId(value: unknown): string | null {
  const trimmed = readTrimmedString(value);
  return trimmed ? trimmed.toLowerCase() : null;
}

function isValidTenantId(tenantId: string): boolean {
  return ENTRA_TENANT_ID_RE.test(tenantId);
}

function getClientIp(req: Request): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim().slice(0, 255) ?? null;
  }

  return req.headers.get("cf-connecting-ip")?.trim().slice(0, 255) ?? null;
}

await runMigrations();
startScheduler();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": homePage,
    "/signin": signinPage,
    "/accept-invitation": acceptInvitationPage,
    "/feedback": feedbackPage,
    "/pricing": pricingPage,
    "/settings": settingsPage,
    "/dashboard": dashboardPage,
    "/api/org/me": {
      GET: async (req) => {
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const domain = session.user.email.split("@")[1];
        if (!domain) return Response.json({ orgId: null, role: null });
        const org = await getOrgByDomain(domain);
        if (!org) return Response.json({ orgId: null, role: null });
        const rows = await Bun.sql`
          SELECT role FROM "member"
          WHERE "organizationId" = ${org.id} AND "userId" = ${session.user.id}
        `;
        return Response.json({ orgId: org.id, role: rows[0]?.role ?? null });
      },
    },
    "/api/org/entra-tenant": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        return Response.json({ entraTenantId: guard.org.entraTenantId ?? null });
      },
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const body = await readJsonBody<{ tenantId?: string | null }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const tenantId = body.tenantId === null ? null : normalizeTenantId(body.tenantId);
        if (tenantId && !isValidTenantId(tenantId)) {
          return errorResponse(400, "Valid Entra tenant ID required");
        }
        await setOrgEntraTenant(guard.org.id, tenantId);
        return Response.json({ ok: true, entraTenantId: tenantId });
      },
    },
    "/api/dashboard/feed": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org } = guard;
        const url = new URL(req.url);
        const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = clampInteger(url.searchParams.get("limit"), 20, 1, MAX_FEED_LIMIT);
        const [items, countRows] = await Promise.all([
          Bun.sql`
            SELECT id, content, created_at FROM reporting.feedback_responses
            WHERE org_domain = ${org.slug}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `,
          Bun.sql`SELECT COUNT(*)::int AS total FROM reporting.feedback_responses WHERE org_domain = ${org.slug}`,
        ]);
        return Response.json({ items, total: countRows[0].total });
      },
    },
    "/api/dashboard/insights": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org } = guard;
        try {
          const cached = await getCachedInsights(org.id);
          if (cached) return Response.json(cached);
          const fresh = await refreshInsights(org.id, org.slug);
          return Response.json(fresh ?? { insights: null, generated_at: null });
        } catch (err) {
          console.error("Insights load error:", err);
          return errorResponse(502, "Failed to generate insights");
        }
      },
    },
    "/api/dashboard/insights/refresh": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org } = guard;
        try {
          const result = await refreshInsights(org.id, org.slug);
          return Response.json(result ?? { insights: null, generated_at: null });
        } catch (err) {
          console.error("Insights refresh error:", err);
          return errorResponse(502, "Failed to refresh insights");
        }
      },
    },
    "/api/dashboard/respond": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org, session } = guard;
        const body = await readJsonBody<{ content?: string; period_label?: string | null }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const content = readTrimmedString(body.content);
        if (!content) return errorResponse(400, "Content required");
        const contentLengthError = requireMaxLength(content, MAX_FEEDBACK_LENGTH, "Content");
        if (contentLengthError) return contentLengthError;
        const periodLabel = readTrimmedString(body.period_label);
        if (periodLabel) {
          const labelLengthError = requireMaxLength(periodLabel, MAX_PERIOD_LABEL_LENGTH, "Period label");
          if (labelLengthError) return labelLengthError;
        }
        await Bun.sql`
          INSERT INTO reporting.leadership_responses (org_id, content, period_label, posted_by)
          VALUES (${org.id}, ${content}, ${periodLabel}, ${session.user.id})
        `;
        return Response.json({ ok: true }, { status: 201 });
      },
    },
    "/api/dashboard/responses": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org } = guard;
        const rows = await Bun.sql`
          SELECT id, content, period_label, posted_at FROM reporting.leadership_responses
          WHERE org_id = ${org.id}
          ORDER BY posted_at DESC
        `;
        return Response.json({ responses: rows });
      },
    },
    "/api/dashboard/deliveries": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org } = guard;
        const rows = await Bun.sql`
          SELECT id, recipient_count, feedback_count, status, error, sent_at
          FROM reporting.batch_deliveries
          WHERE org_id = ${org.id}
          ORDER BY sent_at DESC
          LIMIT 20
        `;
        return Response.json({ deliveries: rows });
      },
    },
    // ── Teams integration ────────────────────────────────────────────────────

    "/api/teams/message": {
      POST: async (req) => {
        const teamsConfig = getTeamsRuntimeConfig();
        if (!teamsConfig.configured || !teamsConfig.appId) {
          return new Response("Teams not configured", { status: 503 });
        }
        if (!(await verifyBotToken(req.headers.get("authorization")))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const activity = await readJsonBody<TeamsActivity>(req);
        if (!activity) return new Response("Invalid JSON body", { status: 400 });

        if (activity.channelId !== "msteams") {
          return new Response(null, { status: 200 });
        }

        const tenantId = activity.channelData?.tenant?.id;
        if (!tenantId) return new Response(null, { status: 200 });

        if (activity.type === "installationUpdate" && activity.action === "add") {
          await sendTeamsReply(
            activity,
            "Anonovox is ready. Send me a message anytime and I'll submit it anonymously.",
          );
          return new Response(null, { status: 200 });
        }

        // Only process user-authored inbound messages from Teams.
        if (activity.type !== "message" || activity.from.id === activity.recipient.id) {
          return new Response(null, { status: 200 });
        }

        if (activity.recipient.id !== teamsConfig.appId) {
          return new Response(null, { status: 200 });
        }

        const text = getNormalizedTeamsMessage(activity);
        const org = await getOrgByTenantId(tenantId);

        if (!org) {
          await sendTeamsReply(
            activity,
            "Anonovox isn't configured for your organization. Ask your admin to connect it in Settings.",
          );
          return new Response(null, { status: 200 });
        }

        if (!text) {
          await sendTeamsReply(activity, "Send me your feedback and I'll submit it anonymously.");
          return new Response(null, { status: 200 });
        }

        if (text.length > MAX_FEEDBACK_LENGTH) {
          await sendTeamsReply(
            activity,
            `Please keep feedback under ${MAX_FEEDBACK_LENGTH} characters.`,
          );
          return new Response(null, { status: 200 });
        }

        const [{ id: responseId }] = await Bun.sql`
          INSERT INTO reporting.feedback_responses (content, org_domain)
          VALUES (${text}, ${org.orgSlug})
          RETURNING id
        `;
        await Bun.sql`
          INSERT INTO private.feedback_identity (response_id, submission_source)
          VALUES (${responseId}, 'teams')
        `;

        await sendTeamsReply(activity, "Your feedback was submitted anonymously. Thank you.");
        return new Response(null, { status: 200 });
      },
    },

    "/api/teams/status": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const connection = await getTeamsConnectionByOrg(guard.org.id);
        const runtime = getTeamsRuntimeConfig();
        return Response.json({
          connected: !!connection,
          tenantId: connection?.tenantId ?? null,
          source: connection?.source ?? null,
          configured: runtime.configured,
          appId: runtime.appId,
          appName: runtime.appName,
          messagingEndpoint: runtime.messagingEndpoint,
          packageUrl: runtime.packageUrl,
        });
      },
    },

    "/api/teams/package": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const runtime = getTeamsRuntimeConfig();
        if (!runtime.configured) {
          return new Response("Teams runtime not configured", { status: 503 });
        }

        const packageBytes = buildTeamsAppPackage();
        return new Response(Buffer.from(packageBytes), {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="anonovox-teams-app.zip"',
            "Cache-Control": "no-store",
          },
        });
      },
    },

    "/api/teams/link": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const body = await readJsonBody<{ tenantId?: string }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const tenantId = normalizeTenantId(body.tenantId);
        if (!tenantId || !isValidTenantId(tenantId)) {
          return errorResponse(400, "Valid tenant ID required");
        }
        await saveTeamsTenant(guard.org.id, tenantId);
        return Response.json({ ok: true });
      },
    },

    "/api/teams": {
      DELETE: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        await deleteTeamsTenant(guard.org.id);
        return Response.json({ ok: true });
      },
    },

    "/api/scheduler/run": {
      POST: async (req) => {
        const secret = process.env.SCHEDULER_SECRET;
        if (!secret) return new Response("Scheduler not configured", { status: 503 });
        if (req.headers.get("authorization") !== `Bearer ${secret}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        void runBatchJob(); // fire-and-forget; Cloud Scheduler doesn't need to wait
        return Response.json({ ok: true });
      },
    },

    "/healthz": {
      // Simple health check endpoint for load balancers / k8s readiness probes.
      GET: () => {
        return Response.json(
          { ok: true, uptime_seconds: Math.floor(process.uptime()) },
          { status: 200 },
        );
      },
    },
    // ── Slack integration ────────────────────────────────────────────────────

    "/api/slack/install": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
          return new Response("Slack not configured", { status: 503 });
        }
        const state = signState(guard.org.id);
        const redirectUri = `${APP_BASE_URL}/api/slack/callback`;
        const url = new URL("https://slack.com/oauth/v2/authorize");
        url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID);
        url.searchParams.set("scope", "commands");
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", state);
        return Response.redirect(url.toString(), 302);
      },
    },

    "/api/slack/callback": {
      GET: async (req) => {
        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
          return Response.redirect("/settings?slack=error", 302);
        }

        if (!code || !state) return Response.redirect("/settings?slack=error", 302);

        const orgId = verifyState(state);
        if (!orgId) return Response.redirect("/settings?slack=error", 302);

        const redirectUri = `${APP_BASE_URL}/api/slack/callback`;
        const credentials = Buffer.from(
          `${process.env.SLACK_CLIENT_ID}:${process.env.SLACK_CLIENT_SECRET}`,
        ).toString("base64");

        const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
          },
          body: new URLSearchParams({ code, redirect_uri: redirectUri }),
        });

        if (!tokenRes.ok) return Response.redirect("/settings?slack=error", 302);

        const data = (await tokenRes.json()) as {
          ok: boolean;
          access_token?: string;
          team?: { id: string; name: string };
        };

        if (!data.ok || !data.team?.id || !data.access_token) {
          return Response.redirect("/settings?slack=error", 302);
        }

        const orgs = await Bun.sql`SELECT id FROM "organization" WHERE id = ${orgId} LIMIT 1`;
        if (!orgs[0]) return Response.redirect("/settings?slack=error", 302);

        await saveSlackWorkspace(orgId, data.team.id, data.team.name, data.access_token, null);
        return Response.redirect("/settings?slack=connected", 302);
      },
    },

    "/api/slack/command": {
      POST: async (req) => {
        const rawBody = await req.text();
        if (!(await verifySlackSignature(req.headers, rawBody))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const params = new URLSearchParams(rawBody);
        const teamId = params.get("team_id") ?? "";
        const text = params.get("text")?.trim() ?? "";

        const workspace = await getSlackWorkspace(teamId);
        if (!workspace) {
          return Response.json({
            response_type: "ephemeral",
            text: "Anonovox isn't connected to this workspace yet. Ask your admin to set it up at your Anonovox settings.",
          });
        }

        if (!text) {
          return Response.json({
            response_type: "ephemeral",
            text: "Usage: `/feedback <your message>`",
          });
        }

        if (text.length > MAX_FEEDBACK_LENGTH) {
          return Response.json({
            response_type: "ephemeral",
            text: `Please keep feedback under ${MAX_FEEDBACK_LENGTH} characters.`,
          });
        }

        const [{ id: responseId }] = await Bun.sql`
          INSERT INTO reporting.feedback_responses (content, org_domain)
          VALUES (${text}, ${workspace.orgSlug})
          RETURNING id
        `;

        await Bun.sql`
          INSERT INTO private.feedback_identity (response_id, submission_source)
          VALUES (${responseId}, 'slack')
        `;

        return Response.json({
          response_type: "ephemeral",
          text: "Your feedback was submitted anonymously. Thank you.",
        });
      },
    },

    "/api/slack/status": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const connection = await getSlackConnectionByOrg(guard.org.id);
        return Response.json({ connected: !!connection, teamName: connection?.teamName ?? null });
      },
    },

    "/api/slack": {
      DELETE: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        await deleteSlackWorkspace(guard.org.id);
        return Response.json({ ok: true });
      },
    },

    "/api/feedback/review": {
      POST: async (req) => {
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return errorResponse(401, "Unauthorized");

        const body = await readJsonBody<{ text?: string; risks?: AnalysisRisk[] }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const text = body.text?.trim() ?? "";
        if (!text) {
          return Response.json(
            { suggestions: [], overall: "", source: "llm" },
            { status: 200 },
          );
        }
        const lengthError = requireMaxLength(text, MAX_FEEDBACK_LENGTH, "Feedback");
        if (lengthError) return lengthError;
        try {
          const result = await reviewDraft(text, body.risks);
          return Response.json(result, { status: 200 });
        } catch (err) {
          console.error("Review draft error:", err);
          return Response.json(
            { error: "Failed to review draft" },
            { status: 500 },
          );
        }
      },
    },
    "/api/feedback/analyze": {
      POST: async (req) => {
        const body = await readJsonBody<{ text?: string }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const text = body.text?.trim() ?? "";
        const lengthError = requireMaxLength(text, MAX_FEEDBACK_LENGTH, "Feedback");
        if (lengthError) return lengthError;
        const result = analyzeText(text);
        return Response.json(result, { status: 200 });
      },
    },
    "/api/feedback": {
      POST: async (req) => {
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return errorResponse(401, "Unauthorized");

        const body = await readJsonBody<{ feedback?: string }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const feedback = body.feedback?.trim();
        if (!feedback) return errorResponse(400, "Feedback is required");
        const lengthError = requireMaxLength(feedback, MAX_FEEDBACK_LENGTH, "Feedback");
        if (lengthError) return lengthError;

        const userId = session.user.id;
        const userEmail = session.user.email;
        const orgDomain = userEmail.split("@")[1] ?? null;
        const ipAddress = getClientIp(req);
        const userAgent = req.headers.get("user-agent")?.slice(0, 512) ?? null;

        // Insert response content into the reporting schema (no PII).
        const [{ id: responseId }] = await Bun.sql`
          INSERT INTO reporting.feedback_responses (content, org_domain)
          VALUES (${feedback}, ${orgDomain})
          RETURNING id
        `;

        // Insert identity data into the private schema (restricted).
        await Bun.sql`
          INSERT INTO private.feedback_identity (response_id, user_id, user_email, ip_address, user_agent)
          VALUES (${responseId}, ${userId}, ${userEmail}, ${ipAddress}, ${userAgent})
        `;

        return Response.json({ ok: true }, { status: 201 });
      },
    },
  },
  fetch(req) {
    return auth.handler(req);
  },
  // enable hot reload and console log output to browser in development mode
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Listening on ${server.url}`);
