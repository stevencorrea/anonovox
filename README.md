# anonovox

Anonymous organisational feedback — employees submit feedback tied to their work email domain, without management knowing who said what.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker + Compose plugin)
- [Bun](https://bun.sh) v1.2+ *(only needed for local type-checking / IDE support — the app runs inside Docker)*

## Local development

### 1. Configure environment

Bun and Docker Compose both read `.env` from the project root. The defaults in `.env` work out of the box for Docker — the only values you may want to rotate are the auth secrets:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Set automatically to the Compose postgres service — override only if using an external DB |
| `BETTER_AUTH_SECRET` | Secret used to sign sessions — rotate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Base URL the server is reachable at (default: `http://localhost:3000`) |
| `BETTER_AUTH_API_KEY` | API key for the Better Auth admin dashboard |

### 2. Start everything

```sh
docker compose up
```

This boots a Postgres 17 container and the app container, wired together. The app waits for Postgres to be healthy before starting. **All database tables — including Better Auth's auth tables — are created automatically on first startup** via `migrate.ts`, so there is no separate migration step.

The app is available at <http://localhost:3000> with hot reload enabled.

### 3. Stop and clean up

```sh
docker compose down          # stop containers, keep the DB volume
docker compose down -v       # stop containers and wipe the DB volume
```

---

## Project structure

```
index.ts            # Bun.serve() — routes and server entry point
auth.ts             # Better Auth configuration (PostgreSQL via pg Pool)
auth-client.ts      # Browser-side auth helpers
migrate.ts          # Creates all DB tables on startup (auth + feedback)
docker-compose.yml  # Local dev: postgres + app with hot reload
Dockerfile          # Production image
signin.html/ts      # Sign-in / sign-up page
feedback.html       # Feedback submission form
index.html          # Landing page
home-nav.ts         # Shared nav component
docs/               # Project proposal and presentation
```

## Database schema

`migrate.ts` owns all table definitions and runs on every startup (`CREATE TABLE IF NOT EXISTS` — idempotent):

**Better Auth tables** — managed by the app, no CLI needed:

| Table | Purpose |
|---|---|
| `user` | Registered users |
| `session` | Active sessions |
| `account` | OAuth / credential accounts linked to a user |
| `verification` | Email verification tokens |

**App tables:**

```sql
CREATE TABLE feedback (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  content     TEXT        NOT NULL,
  user_id     TEXT,                        -- references "user"(id), nullable
  user_email  TEXT,
  org_domain  TEXT,                        -- email domain, e.g. "acme.com"
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
  --entrypoint bun anonovox:latest index.ts --production
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
