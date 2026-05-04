# anonovox

Anonomyzed organizational feedback: employees submit feedback without leadership knowing who said what.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker + Compose plugin)
- [Bun](https://bun.sh) v1.2+ *(only needed for local type-checking / IDE support; the app runs inside Docker)*

## Local development

### 1. Configure environment

Bun and Docker Compose both read `.env` from the project root. The defaults in `.env` work out of the box for Docker; the only values you may want to rotate are the auth secrets:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Set automatically to the Compose postgres service; override only if using an external DB |
| `BETTER_AUTH_SECRET` | Secret used to sign sessions; rotate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Base URL the server is reachable at (default: `http://localhost:3000`) |
| `BETTER_AUTH_API_KEY` | API key for the Better Auth admin dashboard |
| `ADDITIONAL_TRUSTED_ORIGINS` | Optional comma-separated extra origins for Better Auth CORS/trusted-origin checks |
| `ENABLE_IN_PROCESS_SCHEDULER` | Set to `true` to run the hourly digest scheduler inside the web process; production defaults to off |

### 2. Start everything

```sh
docker compose up
```

This boots a Postgres 17 container and the app container, wired together. The app waits for Postgres to be healthy before starting. **All database tables, including Better Auth's auth tables, are created automatically on first startup** via `migrate.ts`, so there is no separate migration step.

The app is available at http://localhost:3000 with hot reload enabled.

Checks:
- `bun run typecheck`
- `bun test`

Accessing /feedback
- The feedback page (GET /feedback) is publicly accessible; anyone can view the submission form without signing in.
- Submitting feedback (POST /api/feedback) requires a valid authenticated session. The app uses the signed-in user's email address to determine which organization the feedback belongs to, so anonymous submissions are not supported.

Examples:
- Development (hot reload):
```sh
bun --hot src/index.ts
```

- Docker:
```sh
docker run --rm -p 3000:3000 anonovox:latest
```

Security note
- Because org routing depends on the submitter's authenticated email address, feedback submission should remain behind authentication in every environment.
- In production, prefer the external scheduler endpoint (`POST /api/scheduler/run`) and leave `ENABLE_IN_PROCESS_SCHEDULER` unset so multiple web instances do not send duplicate digests.

### Microsoft Teams setup

Admins can finish Teams setup from `/settings`:
- Set `TEAMS_APP_ID`, `TEAMS_APP_SECRET`, and a public `BETTER_AUTH_URL`.
- Configure the Azure Bot messaging endpoint to `https://your-domain/api/teams/message`.
- Download the generated Teams app package from Settings and upload it in Teams.
- Link the org tenant either by entering the Microsoft tenant ID in the Teams card or by registering the Entra tenant in the SSO card.

Once installed, users can message the bot directly in Teams and anonovox will strip the bot mention/Teams markup before storing the submission.

### 3. Stop and clean up

```sh
docker compose down          # stop containers, keep the DB volume
docker compose down -v       # stop containers and wipe the DB volume
```

---

## Project structure

```
src/index.ts        # Bun.serve() routes and server entry point
src/server/         # Auth, org resolution, migrations, mailer, scheduler, insights
src/server/integrations/ # Slack + Teams integrations
src/client/         # Browser-side auth helpers and shared UI scripts
src/pages/          # Bun HTML pages and page-specific client scripts
src/lib/            # Shared analysis/review logic
src/styles/         # Shared CSS
tests/              # Bun test files
package.json        # Dependencies and project metadata
bun.lock            # Lockfile for reproducible builds
tsconfig.json       # TypeScript configuration
docker-compose.yml  # Local dev: postgres + app with hot reload
Dockerfile          # Production image
.dockerignore       # Build context filter (excludes .git, node_modules, docs)
docs/               # Project proposal and presentation
```

## Database schema

`src/server/migrate.ts` owns all table definitions and runs on every startup (`CREATE TABLE IF NOT EXISTS`; idempotent):

**Schema separation:** Feedback is split across two schemas to enable safe reporting without exposing PII:
- `reporting.*` contains anonymized feedback content (safe for dashboards and analytics)
- `private.*` contains identity data linked to responses (restricted access)
- The `reporter` role can only access `reporting.*`, ensuring dashboards cannot leak user identities

**Better Auth tables** are managed by the app, no CLI needed:

| Table | Purpose |
|---|---|
| `user` | Registered users |
| `session` | Active sessions |
| `account` | OAuth / credential accounts linked to a user |
| `verification` | Email verification tokens |

**App schemas and tables:**

```sql
CREATE SCHEMA IF NOT EXISTS reporting;
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE reporting.feedback_responses (
  id         TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  content    TEXT        NOT NULL,
  org_domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE private.feedback_identity (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  response_id TEXT        NOT NULL REFERENCES reporting.feedback_responses(id) ON DELETE CASCADE,
  user_id     TEXT,
  user_email  TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX feedback_identity_response_id_idx
  ON private.feedback_identity (response_id);

-- reporter can read reporting data only
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reporter') THEN
    CREATE ROLE reporter NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA reporting TO reporter;
GRANT SELECT ON reporting.feedback_responses TO reporter;
REVOKE ALL ON SCHEMA private FROM reporter;

-- remove old monolithic feedback table
DROP TABLE IF EXISTS public.feedback;
```

---

## Production (Docker)

Build and run a production image against an external database:

```sh
docker build -t anonovox:latest .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/anonovox \
  -e BETTER_AUTH_SECRET=... \
  -e BETTER_AUTH_URL=https://your-domain.com \
  -e BETTER_AUTH_API_KEY=... \
  anonovox:latest
```

Pass env vars via file:

```sh
docker run --rm -p 3000:3000 --env-file .env \
  --entrypoint bun anonovox:latest src/index.ts --production
```

---

## Troubleshooting

**Port 5432 already in use**
Another Postgres instance is running locally. Either stop it (`brew services stop postgresql`) or change the host port in `docker-compose.yml` (e.g. `"5433:5432"`).

**App fails to connect to Postgres on startup**
The health check retries for up to 50 seconds. If it still fails, check the postgres logs:
```sh
docker compose logs postgres
```

**`node_modules` mismatch after `bun install` on host**
The Compose file keeps the container's `node_modules` in a separate anonymous volume so host binaries don't interfere. If you see module errors, rebuild the image:
```sh
docker compose build --no-cache
```
