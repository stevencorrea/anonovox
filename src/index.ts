import homePage from "./pages/index.html";
import feedbackPage from "./pages/feedback.html";
import signinPage from "./pages/signin.html";
import acceptInvitationPage from "./pages/accept-invitation.html";
import pricingPage from "./pages/pricing.html";
import settingsPage from "./pages/settings.html";
import dashboardPage from "./pages/dashboard.html";
import adminPage from "./pages/admin.html";
import { auth } from "./server/auth";
import { runMigrations } from "./server/migrate";
import { analyzeText } from "./lib/analyze";
import type { AnalysisRisk } from "./lib/analyze";
import { reviewDraft } from "./lib/review";
import {
  getSessionOrgMembership,
  requireOrgAdmin,
  requireStaffSession,
  requireVerifiedSession,
  setOrgEntraTenant,
} from "./server/org";
import { validateProductionDatabaseConfig } from "./server/db";
import { instrumentRoutes, getMetricsSnapshot, getRecentSpans, getSystemInfo } from "./lib/telemetry";
import {
  verifySlackSignature,
  signState,
  verifyState,
  getSlackWorkspace,
  saveSlackWorkspace,
  SlackWorkspaceClaimedError,
  deleteSlackWorkspace,
  getSlackConnectionByOrg,
} from "./server/integrations/slack";
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
  TeamsTenantClaimedError,
  type TeamsActivity,
} from "./server/integrations/teams";
import { getCachedInsights, refreshInsights } from "./server/insights";
import { startScheduler, runBatchJob } from "./server/scheduler";

const MAX_FEEDBACK_LENGTH = 4_000;
const MAX_PERIOD_LABEL_LENGTH = 120;
const MAX_FEED_LIMIT = 100;
const MAX_POLL_QUESTION_LENGTH = 240;
const MAX_POLL_OPTION_LENGTH = 80;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 6;
const MAX_POLL_COMMENT_LENGTH = 1_000;
const ENTRA_TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_BASE_URL = process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const IS_HOT_RELOAD = Bun.argv.includes("--hot");
const IS_PRODUCTION_RUNTIME = process.env.NODE_ENV === "production" && !IS_HOT_RELOAD;
const PRODUCTION_REQUIRED_ENV_VARS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

type PollOption = { id: string; label: string };
type StructuredPollRow = {
  id: string;
  org_id: string;
  question: string;
  options: unknown;
  status: "active" | "closed";
  created_at: string;
  closed_at: string | null;
};

type StructuredPollResponseRow = {
  id: string;
  comment: string | null;
  created_at: string;
};

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

function readPollOptions(value: unknown): PollOption[] {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const option = item as { id?: unknown; label?: unknown };
    const label = readTrimmedString(option.label);
    const id = readTrimmedString(option.id) ?? `option-${index + 1}`;
    return label ? [{ id, label }] : [];
  });
}

function normalizePollOptions(value: unknown): { options: PollOption[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: "At least two poll options are required" };
  }

  const options: PollOption[] = [];
  const seenLabels = new Set<string>();

  for (const item of value) {
    const label = readTrimmedString(item);
    if (!label) continue;
    if (label.length > MAX_POLL_OPTION_LENGTH) {
      return { error: `Poll options must be ${MAX_POLL_OPTION_LENGTH} characters or fewer` };
    }
    const normalized = label.toLowerCase();
    if (seenLabels.has(normalized)) {
      return { error: "Poll options must be unique" };
    }
    seenLabels.add(normalized);
    options.push({
      id: `option-${options.length + 1}`,
      label,
    });
  }

  if (options.length < MIN_POLL_OPTIONS) {
    return { error: `At least ${MIN_POLL_OPTIONS} poll options are required` };
  }
  if (options.length > MAX_POLL_OPTIONS) {
    return { error: `No more than ${MAX_POLL_OPTIONS} poll options are allowed` };
  }

  return { options };
}

function formatStructuredPoll(row: StructuredPollRow) {
  return {
    id: row.id,
    question: row.question,
    options: readPollOptions(row.options),
    status: row.status,
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}

async function getLatestStructuredPollForOrg(orgId: string) {
  const rows = await Bun.sql`
    SELECT id, org_id, question, options, status, created_at, closed_at
    FROM reporting.structured_polls
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT 1
  ` as StructuredPollRow[];
  return rows[0] ?? null;
}

async function getActiveStructuredPollForOrg(orgId: string) {
  const rows = await Bun.sql`
    SELECT id, org_id, question, options, status, created_at, closed_at
    FROM reporting.structured_polls
    WHERE org_id = ${orgId} AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  ` as StructuredPollRow[];
  return rows[0] ?? null;
}

async function buildStructuredPollSummary(orgId: string) {
  const pollRow = await getLatestStructuredPollForOrg(orgId);
  if (!pollRow) return null;

  const poll = formatStructuredPoll(pollRow);
  const [countRows, noteRows] = await Promise.all([
    Bun.sql`
      SELECT option_id, COUNT(*)::int AS count
      FROM reporting.structured_poll_responses
      WHERE poll_id = ${poll.id}
      GROUP BY option_id
    ` as unknown as Array<{ option_id: string; count: number }>,
    Bun.sql`
      SELECT id, comment, created_at
      FROM reporting.structured_poll_responses
      WHERE poll_id = ${poll.id}
        AND comment IS NOT NULL
        AND btrim(comment) <> ''
      ORDER BY updated_at DESC
      LIMIT 10
    ` as unknown as StructuredPollResponseRow[],
  ]);

  const countMap = new Map(countRows.map((row) => [row.option_id, Number(row.count)]));
  const totalResponses = [...countMap.values()].reduce((sum, count) => sum + count, 0);

  return {
    ...poll,
    totalResponses,
    breakdown: poll.options.map((option) => {
      const count = countMap.get(option.id) ?? 0;
      return {
        id: option.id,
        label: option.label,
        count,
        percentage: totalResponses > 0 ? Math.round((count / totalResponses) * 1000) / 10 : 0,
      };
    }),
    notes: noteRows.map((row) => ({
      id: row.id,
      comment: row.comment ?? "",
      created_at: row.created_at,
    })),
  };
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

function isUnsetOrPlaceholder(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return !trimmed || trimmed.toUpperCase() === "PLACEHOLDER";
}

function validateRuntimeConfig() {
  if (!IS_PRODUCTION_RUNTIME) return;

  validateProductionDatabaseConfig();

  const missing = PRODUCTION_REQUIRED_ENV_VARS.filter((name) =>
    isUnsetOrPlaceholder(process.env[name]),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required production configuration: ${missing.join(", ")}`,
    );
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(APP_BASE_URL);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid absolute URL in production");
  }

  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsedBaseUrl.hostname)) {
    throw new Error("BETTER_AUTH_URL must not point to localhost in production");
  }
}

validateRuntimeConfig();
await runMigrations();
startScheduler();

const developmentOptions = IS_PRODUCTION_RUNTIME
  ? undefined
  : {
      hmr: true,
      console: true,
    };

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: instrumentRoutes({
    "/": homePage,
    "/signin": signinPage,
    "/accept-invitation": acceptInvitationPage,
    "/feedback": feedbackPage,
    "/pricing": pricingPage,
    "/settings": settingsPage,
    "/dashboard": dashboardPage,
    "/admin": adminPage,
    "/api/org/me": {
      GET: async (req) => {
        const session = await requireVerifiedSession(req);
        if (session instanceof Response) return session;
        const membership = await getSessionOrgMembership(session);
        return Response.json({
          orgId: membership?.org.id ?? null,
          role: membership?.role ?? null,
        });
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
    "/api/dashboard/poll": {
      GET: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const poll = await buildStructuredPollSummary(guard.org.id);
        return Response.json({ poll });
      },
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const body = await readJsonBody<{ question?: string; options?: unknown }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");

        const question = readTrimmedString(body.question);
        if (!question) return errorResponse(400, "Question required");
        const questionLengthError = requireMaxLength(question, MAX_POLL_QUESTION_LENGTH, "Question");
        if (questionLengthError) return questionLengthError;

        const normalizedOptions = normalizePollOptions(body.options);
        if ("error" in normalizedOptions) {
          return errorResponse(400, normalizedOptions.error);
        }

        const existingActive = await getActiveStructuredPollForOrg(guard.org.id);
        if (existingActive) {
          return errorResponse(409, "Close the current active poll before creating a new one");
        }

        await Bun.sql`
          INSERT INTO reporting.structured_polls (org_id, question, options, status, created_by)
          VALUES (
            ${guard.org.id},
            ${question},
            ${JSON.stringify(normalizedOptions.options)}::jsonb,
            'active',
            ${guard.session.user.id}
          )
        `;

        const poll = await buildStructuredPollSummary(guard.org.id);
        return Response.json({ ok: true, poll }, { status: 201 });
      },
      DELETE: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const body = await readJsonBody<{ pollId?: string }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const pollId = readTrimmedString(body.pollId);
        if (!pollId) return errorResponse(400, "Poll ID required");

        const deleted = await Bun.sql`
          DELETE FROM reporting.structured_polls
          WHERE id = ${pollId} AND org_id = ${guard.org.id}
          RETURNING id
        `;
        if (!deleted[0]) return errorResponse(404, "Poll not found");

        const poll = await buildStructuredPollSummary(guard.org.id);
        return Response.json({ ok: true, poll });
      },
    },
    "/api/dashboard/poll/close": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const body = await readJsonBody<{ pollId?: string }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const pollId = readTrimmedString(body.pollId);
        if (!pollId) return errorResponse(400, "Poll ID required");

        const updated = await Bun.sql`
          UPDATE reporting.structured_polls
          SET status = 'closed', closed_at = NOW()
          WHERE id = ${pollId}
            AND org_id = ${guard.org.id}
            AND status = 'active'
          RETURNING id
        `;
        if (!updated[0]) return errorResponse(404, "Active poll not found");

        const poll = await buildStructuredPollSummary(guard.org.id);
        return Response.json({ ok: true, poll });
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
        try {
          await saveTeamsTenant(guard.org.id, tenantId);
        } catch (err) {
          if (err instanceof TeamsTenantClaimedError) {
            return errorResponse(409, "This Teams tenant is already connected to another organization");
          }
          throw err;
        }
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

        try {
          await saveSlackWorkspace(orgId, data.team.id, data.team.name, data.access_token, null);
        } catch (err) {
          if (err instanceof SlackWorkspaceClaimedError) {
            return Response.redirect("/settings?slack=claimed", 302);
          }
          throw err;
        }
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
    "/api/feedback/poll": {
      GET: async (req) => {
        const session = await requireVerifiedSession(req);
        if (session instanceof Response) return session;
        const membership = await getSessionOrgMembership(session);
        if (!membership) return errorResponse(403, "No organization found");

        const pollRow = await getActiveStructuredPollForOrg(membership.org.id);
        if (!pollRow) return Response.json({ poll: null, myResponse: null });

        const poll = formatStructuredPoll(pollRow);
        const responses = await Bun.sql`
          SELECT r.option_id, r.comment, r.updated_at
          FROM reporting.structured_poll_responses r
          JOIN private.structured_poll_identity i ON i.response_id = r.id
          WHERE i.poll_id = ${poll.id}
            AND i.user_id = ${session.user.id}
          LIMIT 1
        ` as Array<{ option_id: string; comment: string | null; updated_at: string }>;

        return Response.json({
          poll,
          myResponse: responses[0]
            ? {
              optionId: responses[0].option_id,
              comment: responses[0].comment,
              updated_at: responses[0].updated_at,
            }
            : null,
        });
      },
      POST: async (req) => {
        const session = await requireVerifiedSession(req);
        if (session instanceof Response) return session;
        const membership = await getSessionOrgMembership(session);
        if (!membership) return errorResponse(403, "No organization found");

        const body = await readJsonBody<{ pollId?: string; optionId?: string; comment?: string | null }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");

        const pollId = readTrimmedString(body.pollId);
        const optionId = readTrimmedString(body.optionId);
        if (!pollId) return errorResponse(400, "Poll ID required");
        if (!optionId) return errorResponse(400, "Option required");

        const comment = body.comment === null ? null : readTrimmedString(body.comment);
        if (comment) {
          const commentLengthError = requireMaxLength(comment, MAX_POLL_COMMENT_LENGTH, "Comment");
          if (commentLengthError) return commentLengthError;
        }

        const pollRow = await getActiveStructuredPollForOrg(membership.org.id);
        if (!pollRow || pollRow.id !== pollId) {
          return errorResponse(404, "Active poll not found");
        }

        const poll = formatStructuredPoll(pollRow);
        if (!poll.options.some((option) => option.id === optionId)) {
          return errorResponse(400, "Invalid poll option");
        }

        const existing = await Bun.sql`
          SELECT response_id
          FROM private.structured_poll_identity
          WHERE poll_id = ${pollId}
            AND user_id = ${session.user.id}
          LIMIT 1
        ` as Array<{ response_id: string }>;

        if (existing[0]) {
          await Bun.sql`
            UPDATE reporting.structured_poll_responses
            SET option_id = ${optionId},
                comment = ${comment},
                updated_at = NOW()
            WHERE id = ${existing[0].response_id}
          `;
          await Bun.sql`
            UPDATE private.structured_poll_identity
            SET user_email = ${session.user.email},
                updated_at = NOW()
            WHERE response_id = ${existing[0].response_id}
          `;
        } else {
          const inserted = await Bun.sql`
            INSERT INTO reporting.structured_poll_responses (poll_id, option_id, comment)
            VALUES (${pollId}, ${optionId}, ${comment})
            RETURNING id
          ` as unknown as Array<{ id: string }>;
          const responseId = inserted[0]?.id;
          if (!responseId) return errorResponse(500, "Failed to save poll response");

          await Bun.sql`
            INSERT INTO private.structured_poll_identity (poll_id, response_id, user_id, user_email)
            VALUES (${pollId}, ${responseId}, ${session.user.id}, ${session.user.email})
          `;
        }

        const responses = await Bun.sql`
          SELECT r.option_id, r.comment, r.updated_at
          FROM reporting.structured_poll_responses r
          JOIN private.structured_poll_identity i ON i.response_id = r.id
          WHERE i.poll_id = ${pollId}
            AND i.user_id = ${session.user.id}
          LIMIT 1
        ` as Array<{ option_id: string; comment: string | null; updated_at: string }>;

        return Response.json({
          ok: true,
          myResponse: responses[0]
            ? {
              optionId: responses[0].option_id,
              comment: responses[0].comment,
              updated_at: responses[0].updated_at,
            }
            : null,
        }, { status: 201 });
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
        const session = await requireVerifiedSession(req);
        if (session instanceof Response) return session;
        const membership = await getSessionOrgMembership(session);
        if (!membership) return errorResponse(403, "No organization found");

        const body = await readJsonBody<{ feedback?: string }>(req);
        if (!body) return errorResponse(400, "Invalid JSON body");
        const feedback = body.feedback?.trim();
        if (!feedback) return errorResponse(400, "Feedback is required");
        const lengthError = requireMaxLength(feedback, MAX_FEEDBACK_LENGTH, "Feedback");
        if (lengthError) return lengthError;

        const userId = session.user.id;
        const userEmail = session.user.email;
        const orgDomain = membership.org.slug;
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
    "/api/admin/system": {
      GET: async (req) => {
        const session = await requireStaffSession(req);
        if (session instanceof Response) return session;
        const [dbRows] = await Promise.all([
          Bun.sql`
            SELECT
              version() AS version,
              current_database() AS database,
              pg_postmaster_start_time() AS pg_start_time
          `,
        ]) as [Array<{ version: string; database: string; pg_start_time: string }>];
        const [orgsRow, usersRow, slackRow, teamsRow] = await Promise.all([
          Bun.sql`SELECT COUNT(*)::int AS count FROM "organization"`,
          Bun.sql`SELECT COUNT(*)::int AS count FROM "user"`,
          Bun.sql`SELECT COUNT(*)::int AS count FROM integration.slack_workspaces`,
          Bun.sql`SELECT COUNT(*)::int AS count FROM integration.teams_tenants`,
        ]) as [
          Array<{ count: number }>,
          Array<{ count: number }>,
          Array<{ count: number }>,
          Array<{ count: number }>,
        ];
        return Response.json({
          node: getSystemInfo(),
          db: {
            connected: true,
            version: dbRows[0]?.version ?? null,
            database: dbRows[0]?.database ?? null,
            postgresUptimeSince: dbRows[0]?.pg_start_time ?? null,
          },
          integrations: {
            orgs: orgsRow[0]?.count ?? 0,
            users: usersRow[0]?.count ?? 0,
            slackWorkspaces: slackRow[0]?.count ?? 0,
            teamstenants: teamsRow[0]?.count ?? 0,
          },
        });
      },
    },
    "/api/admin/metrics": {
      GET: async (req) => {
        const session = await requireStaffSession(req);
        if (session instanceof Response) return session;
        return Response.json(getMetricsSnapshot());
      },
    },
    "/api/admin/spans": {
      GET: async (req) => {
        const session = await requireStaffSession(req);
        if (session instanceof Response) return session;
        return Response.json(getRecentSpans(80));
      },
    },
  }),
  fetch(req) {
    return auth.handler(req);
  },
  development: developmentOptions,
});

console.log(`Listening on ${server.url}`);
