import homePage from "./index.html";
import feedbackPage from "./feedback.html";
import signinPage from "./signin.html";
import { auth } from "./auth";
import { runMigrations } from "./migrate";
import { analyzeText } from "./analyze";
import { reviewDraft } from "./review";

await runMigrations();

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": homePage,
    "/signin": signinPage,
    "/feedback": feedbackPage,
    "/healthz": {
      // Simple health check endpoint for load balancers / k8s readiness probes.
      GET: () => {
        return Response.json(
          { ok: true, uptime_seconds: Math.floor(process.uptime()) },
          { status: 200 },
        );
      },
    },
    "/api/feedback/review": {
      POST: async (req) => {
        const body = (await req.json()) as { text?: string };
        const text = body.text?.trim() ?? "";
        if (!text) {
          return Response.json(
            { suggestions: [], overall: "", source: "llm" },
            { status: 200 },
          );
        }
        try {
          const result = await reviewDraft(text);
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
