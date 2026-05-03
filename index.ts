import homePage from "./index.html";
import feedbackPage from "./feedback.html";
import signinPage from "./signin.html";
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
  type TeamsActivity,
} from "./teams";
import { getCachedInsights, refreshInsights } from "./insights";
import { startScheduler, runBatchJob } from "./scheduler";

await runMigrations();
startScheduler();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": homePage,
    "/signin": signinPage,
    "/feedback": feedbackPage,
    "/pricing": pricingPage,
    "/settings": settingsPage,
    "/dashboard": dashboardPage,
    "/api/org/me": {
      GET: async (req) => {
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const domain = session.user.email.split("@")[1];
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
        const body = await req.json() as { tenantId?: string };
        const tenantId = body.tenantId?.trim() || null;
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
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
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
        const cached = await getCachedInsights(org.id);
        if (cached) return Response.json(cached);
        const fresh = await refreshInsights(org.id, org.slug);
        return Response.json(fresh ?? { insights: null, generated_at: null });
      },
    },
    "/api/dashboard/insights/refresh": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org } = guard;
        const result = await refreshInsights(org.id, org.slug);
        return Response.json(result ?? { insights: null, generated_at: null });
      },
    },
    "/api/dashboard/respond": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const { org, session } = guard;
        const body = await req.json() as { content?: string; period_label?: string };
        const content = body.content?.trim();
        if (!content) return Response.json({ error: "Content required" }, { status: 400 });
        await Bun.sql`
          INSERT INTO reporting.leadership_responses (org_id, content, period_label, posted_by)
          VALUES (${org.id}, ${content}, ${body.period_label ?? null}, ${session.user.id})
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
        if (!process.env.TEAMS_APP_ID && !process.env.MICROSOFT_CLIENT_ID) {
          return new Response("Teams not configured", { status: 503 });
        }
        if (!(await verifyBotToken(req.headers.get("authorization")))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const activity = (await req.json()) as TeamsActivity;

        // Only process inbound messages from Teams
        if (activity.type !== "message" || activity.channelId !== "msteams") {
          return new Response(null, { status: 200 });
        }

        const tenantId = activity.channelData?.tenant?.id;
        if (!tenantId) return new Response(null, { status: 200 });

        const text = activity.text?.trim() ?? "";
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
        return Response.json({
          connected: !!connection,
          tenantId: connection?.tenantId ?? null,
          source: connection?.source ?? null,
        });
      },
    },

    "/api/teams/link": {
      POST: async (req) => {
        const guard = await requireOrgAdmin(req);
        if (guard instanceof Response) return guard;
        const body = (await req.json()) as { tenantId?: string };
        const tenantId = body.tenantId?.trim();
        if (!tenantId) return Response.json({ error: "Tenant ID required" }, { status: 400 });
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
        runBatchJob(); // fire-and-forget; Cloud Scheduler doesn't need to wait
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
        const state = signState(guard.org.id);
        const redirectUri = `${process.env.BETTER_AUTH_URL}/api/slack/callback`;
        const url = new URL("https://slack.com/oauth/v2/authorize");
        url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
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

        if (!code || !state) return Response.redirect("/settings?slack=error", 302);

        const orgId = verifyState(state);
        if (!orgId) return Response.redirect("/settings?slack=error", 302);

        const redirectUri = `${process.env.BETTER_AUTH_URL}/api/slack/callback`;
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

        const data = (await tokenRes.json()) as {
          ok: boolean;
          access_token?: string;
          team?: { id: string; name: string };
        };

        if (!data.ok || !data.team?.id) return Response.redirect("/settings?slack=error", 302);

        const orgs = await Bun.sql`SELECT id FROM "organization" WHERE id = ${orgId} LIMIT 1`;
        if (!orgs[0]) return Response.redirect("/settings?slack=error", 302);

        await saveSlackWorkspace(orgId, data.team.id, data.team.name, data.access_token ?? "", null);
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
        const body = (await req.json()) as { text?: string; risks?: AnalysisRisk[] };
        const text = body.text?.trim() ?? "";
        if (!text) {
          return Response.json(
            { suggestions: [], overall: "", source: "llm" },
            { status: 200 },
          );
        }
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
        const body = (await req.json()) as { text?: string };
        const text = body.text?.trim() ?? "";
        const result = analyzeText(text);
        return Response.json(result, { status: 200 });
      },
    },
    "/api/feedback": {
      // Our feedback endpoint taskes a POST behind a feature flag.
      // When production is enabled, we require a session to be present,
      // else, we allow anyone to submit feedback.
      POST: async (req) => {
        const body = (await req.json()) as { feedback?: string };
        const feedback = body.feedback?.trim();

        if (!feedback) {
          return Response.json(
            { error: "Feedback is required" },
            { status: 400 },
          );
        }

        const disableAuth = process.env.DISABLE_AUTH === "true";
        // When DISABLE_AUTH=true we skip fetching the session so anyone can submit feedback.
        const session = disableAuth
          ? null
          : await auth.api.getSession({ headers: req.headers });
        const userId = session?.user?.id ?? null;
        const userEmail = session?.user?.email ?? null;
        const orgDomain = userEmail ? userEmail.split("@")[1] : null;
        const ipAddress =
          req.headers.get("x-forwarded-for") ??
          req.headers.get("cf-connecting-ip") ??
          null;
        const userAgent = req.headers.get("user-agent") ?? null;

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
    // Allow unauthenticated access to the feedback page (GET /feedback) by serving
    // the feedback HTML directly. All other requests are delegated to the auth handler.
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/feedback") {
      return feedbackPage;
    }
    return auth.handler(req);
  },
  // enable hot reload and console log output to browser in development mode
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Listening on ${server.url}`);
