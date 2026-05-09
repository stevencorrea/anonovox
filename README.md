# anonovox

Anonymous organizational feedback for teams that want three things in one place:
- freeform feedback collection
- structured top-down polls
- executive reporting with AI summaries

The app is built with Bun, Better Auth, and Postgres.

**Quickstart**
1. Install dependencies for local tooling:

```sh
bun install
```

2. Create your local env file:

```sh
cp .env.example .env
```

3. Edit `.env` and set at least:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/anonovox
BETTER_AUTH_SECRET=replace-with-a-random-secret
BETTER_AUTH_URL=http://localhost:3000
```

4. Start the local stack:

```sh
docker compose up --build
```

5. Open [http://localhost:3000](http://localhost:3000)

6. Useful checks:

```sh
bun run typecheck
bun test
```

The Docker compose stack runs Postgres, Jaeger, and the Bun app with hot reload. Database setup is automatic on startup via [`src/server/migrate.ts`](/Users/steven/Documents/anonovox/src/server/migrate.ts). The committed [`.env.example`](/Users/steven/Documents/anonovox/.env.example) includes placeholders for every supported integration.

**Local Workflow**
- Sign up at `/signin`
- Submit feedback at `/feedback`
- Review executive reporting at `/dashboard`
- Manage org settings, Slack, Teams, and Entra configuration at `/settings`

Feedback submission requires an authenticated user because org routing is derived from the user’s verified membership.

**Environment Variables**

Core app and auth:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `BETTER_AUTH_SECRET` | yes | Session and auth signing secret |
| `BETTER_AUTH_URL` | yes | Public base URL for auth callbacks and generated links |
| `PORT` | no | HTTP port, defaults to `3000` |
| `NODE_ENV` | no | `development` locally, `production` for hardened runtime checks |
| `ADDITIONAL_TRUSTED_ORIGINS` | no | Extra comma-separated origins trusted by Better Auth |

For local development, use `DATABASE_URL`.

For production, use a traditional Postgres connection string in `DATABASE_URL`. For a Cloud SQL private IP deployment, that looks like:

```env
DATABASE_URL=postgresql://anonovoxapp:replace-with-your-db-password@10.33.192.3:5432/YOUR_DATABASE_NAME
```

For a Docker VM on Compute Engine, point `DATABASE_URL` at the Cloud SQL instance private IP that you already verified from the VM.
For Cloud Run, direct private-IP TCP requires the service egress path to reach the same VPC network as the Cloud SQL instance.

The runtime also clears Bun's alternate Postgres URL env vars (`POSTGRES_URL`, `PGURL`, `PG_URL`, `TLS_POSTGRES_DATABASE_URL`, `TLS_DATABASE_URL`) before creating the SQL client. If any of those are still set in your deployment, remove them anyway so the runtime config stays obvious.

Email and digests:

| Variable | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | for real email | Enables outbound email delivery |
| `EMAIL_FROM` | for real email | From address used for invites and digest mail |

If these are missing, the app still runs locally but email delivery is skipped.

AI insights:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | for AI review/summaries | Enables draft review and aggregated insight generation |

Without this key, the app can still collect feedback and polls, but AI review and insight refreshes will not work.

Microsoft sign-in and optional Entra SSO:

| Variable | Required | Purpose |
|---|---|---|
| `MICROSOFT_CLIENT_ID` | for Microsoft auth | OAuth client ID |
| `MICROSOFT_CLIENT_SECRET` | for Microsoft auth | OAuth client secret |
| `MICROSOFT_TENANT_ID` | optional | OAuth tenant scope, defaults to `common` |
| `ENTRA_ADMIN_ROLE_IDS` | optional | Comma-separated Entra role IDs that should map to org admin |
| `STAFF_EMAIL_DOMAIN` | optional | Internal staff domain for staff-only admin routes |

Entra is an optional enterprise feature. Standard domain-based onboarding still works without it.

Teams integration:

| Variable | Required | Purpose |
|---|---|---|
| `TEAMS_APP_ID` | for Teams bot | Bot/application ID |
| `TEAMS_APP_SECRET` | for Teams bot | Bot secret |

`TEAMS_APP_ID` and `TEAMS_APP_SECRET` fall back to `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` if you want to reuse the same Azure app.

Slack integration:

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_CLIENT_ID` | for Slack install flow | Slack OAuth client ID |
| `SLACK_CLIENT_SECRET` | for Slack install flow | Slack OAuth client secret |
| `SLACK_SIGNING_SECRET` | for slash commands/events | Verifies inbound Slack requests |

Scheduler:

| Variable | Required | Purpose |
|---|---|---|
| `ENABLE_IN_PROCESS_SCHEDULER` | optional | Forces the scheduler to run in-process |
| `SCHEDULER_SECRET` | for external scheduler endpoint | Protects `POST /api/scheduler/run` |

In local development the scheduler runs automatically unless `NODE_ENV=production`. In production, prefer the protected scheduler endpoint over running multiple web instances with in-process scheduling enabled.

Observability:

| Variable | Required | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | Sends OpenTelemetry traces to an OTLP collector |

The included compose file points this at the local Jaeger container.

**Cloud Run Deploy**

The app is currently being managed directly in Google Cloud / Cloud Run.

If you want a scripted deploy path later, the repo includes an optional [`cloudbuild.yaml`](/Users/steven/Documents/anonovox/cloudbuild.yaml) that:
- builds and pushes the container image
- deploys to Cloud Run
- sets `NODE_ENV=production`
- injects `DATABASE_URL` from Secret Manager
- removes older `PG*`-style Cloud SQL env/secrets from the service during deploy

Required substitutions and secrets:
- substitutions: `_REGION`, `_SERVICE`, `_AR_REPO`, `_RUNTIME_SERVICE_ACCOUNT`
- Secret Manager: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SCHEDULER_SECRET`, plus any integration/API secrets you use

Example:

```sh
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION=us-west1,_SERVICE=anonovox,_AR_REPO=anonovox,_RUNTIME_SERVICE_ACCOUNT=anonovox-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

If Cloud Run is using a private-IP Cloud SQL address in `DATABASE_URL`, configure Direct VPC egress or a Serverless VPC Access connector so the service can reach that VPC.
Make sure the service does not keep stale values for `POSTGRES_URL`, `PGURL`, `PG_URL`, `TLS_POSTGRES_DATABASE_URL`, or `TLS_DATABASE_URL`.

**Feature Notes**
- Auth, sessions, and invites are handled by Better Auth in [`src/server/auth.ts`](/Users/steven/Documents/anonovox/src/server/auth.ts).
- Org resolution, verified-session checks, and Entra tenant mapping live in [`src/server/org.ts`](/Users/steven/Documents/anonovox/src/server/org.ts).
- Slack and Teams integrations live in [`src/server/integrations/`](/Users/steven/Documents/anonovox/src/server/integrations).
- Dashboard insights and email digests are driven by [`src/server/insights.ts`](/Users/steven/Documents/anonovox/src/server/insights.ts), [`src/server/mailer.ts`](/Users/steven/Documents/anonovox/src/server/mailer.ts), and [`src/server/scheduler.ts`](/Users/steven/Documents/anonovox/src/server/scheduler.ts).

**Project Layout**
```text
src/
  index.ts                  Bun server entrypoint
  pages/                    HTML pages and page-specific client code
  client/                   Shared browser-side helpers
  lib/                      Shared analysis, review, and telemetry helpers
  server/                   Auth, org, migrations, mailer, scheduler, insights
  server/integrations/      Slack and Teams integrations
  styles/                   Shared CSS
tests/                      Bun tests
docker-compose.yml          Local development stack
Dockerfile                  Production container image
```

**Troubleshooting**

Port `5432` already in use:

```sh
docker compose down
```

Then either stop your local Postgres instance or change the host port mapping in [`docker-compose.yml`](/Users/steven/Documents/anonovox/docker-compose.yml).

Need a clean local reset:

```sh
docker compose down -v
docker compose up --build
```

Container starts but app is failing:

```sh
docker compose logs app
docker compose logs postgres
```
