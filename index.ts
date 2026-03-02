import homePage from "./index.html";
import feedbackPage from "./feedback.html";
import signinPage from "./signin.html";
import { auth } from "./auth";

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": homePage,
    "/signin": signinPage,
    "/feedback": feedbackPage,
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

        // TODO: persist feedback in postgres db
        console.log("Feedback received:", feedback);

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
