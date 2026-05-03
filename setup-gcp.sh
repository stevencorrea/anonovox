#!/usr/bin/env bash
# One-time GCP setup for anonovox.
# Run this once before your first deploy. Safe to re-run — most commands are idempotent.
#
# Prerequisites:
#   gcloud CLI installed and authenticated (gcloud auth login)
#   Sufficient IAM permissions on the target project (Owner or Editor + Security Admin)
#
# Usage:
#   chmod +x setup-gcp.sh
#   ./setup-gcp.sh

set -euo pipefail

# ── Configuration — edit these before running ─────────────────────────────────

PROJECT_ID="your-gcp-project-id"
REGION="us-central1"
GITHUB_REPO="your-org/anonovox"           # e.g. "acmecorp/anonovox"
DB_INSTANCE="anonovox"                    # Cloud SQL instance name
DB_NAME="anonovox"
DB_USER="anonovox"
APP_DOMAIN="https://your-app-domain.com"  # or Cloud Run URL after first deploy

# Derived — no need to edit
SERVICE="anonovox"
AR_REPO="anonovox"
DEPLOY_SA="anonovox-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="anonovox-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL="github-actions"
WIF_PROVIDER="github"
SQL_INSTANCE="${PROJECT_ID}:${REGION}:${DB_INSTANCE}"

echo "==> Setting project to ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

# ── 1. Enable required APIs ───────────────────────────────────────────────────
echo "==> Enabling APIs…"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com

# ── 2. Artifact Registry ──────────────────────────────────────────────────────
echo "==> Creating Artifact Registry repository…"
gcloud artifacts repositories create "${AR_REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="anonovox container images" \
  2>/dev/null || echo "    (already exists)"

# ── 3. Cloud SQL ──────────────────────────────────────────────────────────────
echo "==> Creating Cloud SQL instance (PostgreSQL 16)…"
echo "    This takes ~5 minutes. Grab a coffee."
gcloud sql instances create "${DB_INSTANCE}" \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region="${REGION}" \
  --no-assign-ip \
  --enable-google-private-path \
  2>/dev/null || echo "    (already exists)"

echo "==> Creating database and user…"
gcloud sql databases create "${DB_NAME}" --instance="${DB_INSTANCE}" 2>/dev/null || echo "    (already exists)"

DB_PASSWORD=$(openssl rand -base64 24)
gcloud sql users create "${DB_USER}" \
  --instance="${DB_INSTANCE}" \
  --password="${DB_PASSWORD}" \
  2>/dev/null || echo "    (user already exists — password not changed)"

# Construct DATABASE_URL using the Cloud SQL socket path (used by Cloud Run)
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@/${DB_NAME}?host=/cloudsql/${SQL_INSTANCE}"
echo ""
echo "    DATABASE_URL (save this — shown once):"
echo "    ${DATABASE_URL}"
echo ""

# ── 4. Service accounts ───────────────────────────────────────────────────────
echo "==> Creating service accounts…"

gcloud iam service-accounts create anonovox-deploy \
  --display-name="anonovox GitHub Actions deploy" \
  2>/dev/null || echo "    (deploy SA already exists)"

gcloud iam service-accounts create anonovox-runtime \
  --display-name="anonovox Cloud Run runtime" \
  2>/dev/null || echo "    (runtime SA already exists)"

# Deploy SA permissions
echo "==> Granting deploy SA permissions…"
for ROLE in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
done

# Runtime SA permissions
echo "==> Granting runtime SA permissions…"
for ROLE in roles/secretmanager.secretAccessor roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
done

# ── 5. Workload Identity Federation ──────────────────────────────────────────
echo "==> Setting up Workload Identity Federation…"

gcloud iam workload-identity-pools create "${WIF_POOL}" \
  --location=global \
  --display-name="GitHub Actions" \
  2>/dev/null || echo "    (pool already exists)"

gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
  --location=global \
  --workload-identity-pool="${WIF_POOL}" \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
  2>/dev/null || echo "    (provider already exists)"

WIF_POOL_ID=$(gcloud iam workload-identity-pools describe "${WIF_POOL}" \
  --location=global \
  --format="value(name)")

gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}" \
  --quiet

WIF_PROVIDER_FULL="${WIF_POOL_ID}/providers/${WIF_PROVIDER}"
echo ""
echo "    WIF Provider (add to GitHub repo vars as GCP_WIF_PROVIDER):"
echo "    ${WIF_PROVIDER_FULL}"
echo ""

# ── 6. Secret Manager ─────────────────────────────────────────────────────────
echo "==> Creating secrets in Secret Manager…"

SCHEDULER_SECRET=$(openssl rand -base64 32)

create_secret() {
  local NAME=$1
  local VALUE=$2
  if gcloud secrets describe "${NAME}" --quiet 2>/dev/null; then
    echo "    ${NAME} already exists — skipping (update manually if needed)"
  else
    printf '%s' "${VALUE}" | gcloud secrets create "${NAME}" \
      --data-file=- \
      --replication-policy=automatic
    echo "    Created: ${NAME}"
  fi
}

# Populate known values; leave placeholders for secrets you'll fill in manually
create_secret "DATABASE_URL"          "${DATABASE_URL}"
create_secret "BETTER_AUTH_SECRET"    "$(openssl rand -base64 32)"
create_secret "BETTER_AUTH_URL"       "${APP_DOMAIN}"
create_secret "BETTER_AUTH_API_KEY"   "$(openssl rand -base64 24 | tr -d '/')"
create_secret "SCHEDULER_SECRET"      "${SCHEDULER_SECRET}"

# Secrets that need real values — created with placeholder so deploy doesn't fail
for NAME in \
  ANTHROPIC_API_KEY \
  RESEND_API_KEY \
  EMAIL_FROM \
  MICROSOFT_CLIENT_ID \
  MICROSOFT_CLIENT_SECRET \
  MICROSOFT_TENANT_ID \
  ENTRA_ADMIN_ROLE_IDS \
  SLACK_CLIENT_ID \
  SLACK_CLIENT_SECRET \
  SLACK_SIGNING_SECRET; do
  create_secret "${NAME}" "PLACEHOLDER"
done

echo ""
echo "    SCHEDULER_SECRET (save this — used for Cloud Scheduler job):"
echo "    ${SCHEDULER_SECRET}"
echo ""
echo "    Update placeholder secrets with real values:"
echo "    gcloud secrets versions add SECRET_NAME --data-file=<(echo -n 'real-value')"
echo ""

# ── 7. Cloud Scheduler ────────────────────────────────────────────────────────
echo "==> Creating Cloud Scheduler nightly digest job…"
echo "    (Update --uri once you have the Cloud Run URL from the first deploy)"

SERVICE_URL="${APP_DOMAIN}"

gcloud scheduler jobs create http anonovox-nightly-digest \
  --schedule="0 8 * * *" \
  --uri="${SERVICE_URL}/api/scheduler/run" \
  --message-body='{}' \
  --headers="Authorization=Bearer ${SCHEDULER_SECRET},Content-Type=application/json" \
  --time-zone="UTC" \
  --location="${REGION}" \
  2>/dev/null || echo "    (job already exists — update URI manually once you have the Cloud Run URL)"

# ── 8. GitHub repository variables ────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Add these to your GitHub repo → Settings → Secrets & variables → Variables:"
echo ""
echo "  GCP_PROJECT_ID              = ${PROJECT_ID}"
echo "  GCP_REGION                  = ${REGION}"
echo "  GCP_SERVICE_ACCOUNT         = ${DEPLOY_SA}"
echo "  GCP_RUNTIME_SERVICE_ACCOUNT = ${RUNTIME_SA}"
echo "  GCP_WIF_PROVIDER            = ${WIF_PROVIDER_FULL}"
echo "  CLOUD_SQL_INSTANCE          = ${SQL_INSTANCE}"
echo ""
echo "  No GitHub secrets needed — all app secrets live in GCP Secret Manager."
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Fill in placeholder secrets with real values (see above)"
echo "  2. Add GitHub repo variables listed above"
echo "  3. Push to main — GitHub Actions will build and deploy"
echo "  4. After first deploy, update BETTER_AUTH_URL secret and Cloud Scheduler"
echo "     job URI with your Cloud Run URL (printed in the workflow summary)"
echo "  5. Update your Slack app's OAuth redirect URL and slash command URL"
echo "     to the Cloud Run URL"
echo ""
echo "Done."
