import homePage from "./index.html";
import feedbackPage from "./feedback.html";
import signinPage from "./signin.html";
import { auth } from "./auth";
import { runMigrations } from "./migrate";

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

        const session = await auth.api.getSession({ headers: req.headers });
        const userId = session?.user?.id ?? null;
        const userEmail = session?.user?.email ?? null;
        const orgDomain = userEmail ? userEmail.split("@")[1] : null;
        const ipAddress =
          req.headers.get("x-forwarded-for") ??
          req.headers.get("cf-connecting-ip") ??
          null;
        const userAgent = req.headers.get("user-agent") ?? null;

        await Bun.sql`
          INSERT INTO feedback (content, user_id, user_email, org_domain, ip_address, user_agent)
          VALUES (${feedback}, ${userId}, ${userEmail}, ${orgDomain}, ${ipAddress}, ${userAgent})
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
