import { generateInsightsForOrgWindow } from "./insights";
import { LEADER_ROLE, listOrgLeaderRecipients } from "./org";
import { sql } from "./db";
import { sendBatchDigest } from "./mailer";

// How often the scheduler polls for eligible orgs
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Initial delay before first run after startup
const STARTUP_DELAY_MS = 60 * 1000; // 1 minute
let schedulerStarted = false;
let inFlightBatchJob: Promise<void> | null = null;

export function startScheduler() {
  const shouldRunInternally =
    process.env.ENABLE_IN_PROCESS_SCHEDULER === "true"
    || process.env.NODE_ENV !== "production";

  if (!shouldRunInternally) {
    console.log("[scheduler] In-process scheduler disabled for this environment.");
    return;
  }

  if (schedulerStarted) return;
  schedulerStarted = true;
  console.log("[scheduler] Starting. First run in 1 minute, then every hour.");
  setTimeout(() => {
    void runBatchJob();
    setInterval(runBatchJob, POLL_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

// Exported so it can be triggered via POST /api/scheduler/run in production
export async function runBatchJob() {
  if (inFlightBatchJob) {
    console.log("[scheduler] Batch job already running, skipping overlapping trigger.");
    return inFlightBatchJob;
  }

  inFlightBatchJob = runBatchJobOnce().finally(() => {
    inFlightBatchJob = null;
  });

  return inFlightBatchJob;
}

export function getPreviousMonthlyDigestPeriod(referenceDate = new Date()) {
  const periodEnd = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  ));
  const periodStart = new Date(Date.UTC(
    periodEnd.getUTCFullYear(),
    periodEnd.getUTCMonth() - 1,
    1,
    0,
    0,
    0,
    0,
  ));
  const periodLabel = periodStart.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return { periodStart, periodEnd, periodLabel };
}

async function runBatchJobOnce() {
  console.log("[scheduler] Running monthly batch job…");
  try {
    // All orgs that have at least one leader recipient with an email.
    const orgs = await sql`
      SELECT DISTINCT o.id, o.name, o.slug
      FROM "organization" o
      JOIN private.org_role_assignments assignment
        ON assignment.org_id = o.id
       AND assignment.role = ${LEADER_ROLE}
      JOIN "member" m
        ON m."organizationId" = o.id
       AND m."userId" = assignment.user_id
      JOIN "user" u ON u.id = assignment.user_id
      WHERE u.email IS NOT NULL
    `;

    let sent = 0;
    let skipped = 0;

    for (const org of orgs as { id: string; name: string; slug: string }[]) {
      const dispatched = await tryBatchOrg(org);
      dispatched ? sent++ : skipped++;
    }

    console.log(`[scheduler] Done. Batches sent: ${sent}, skipped: ${skipped}`);
  } catch (err) {
    console.error("[scheduler] Batch job error:", err);
  }
}

async function tryBatchOrg(org: { id: string; name: string; slug: string }): Promise<boolean> {
  const { periodStart, periodEnd, periodLabel } = getPreviousMonthlyDigestPeriod();

  if (periodEnd.getTime() <= periodStart.getTime()) return false;

  const deliveredRows = await sql`
    SELECT id
    FROM reporting.batch_deliveries
    WHERE org_id = ${org.id}
      AND status = 'sent'
      AND period_start = ${periodStart.toISOString()}::timestamptz
      AND period_end = ${periodEnd.toISOString()}::timestamptz
    LIMIT 1
  `;
  if (deliveredRows[0]) return false;

  const countRows = await sql`
    SELECT COUNT(*)::int AS count FROM reporting.feedback_responses
    WHERE org_domain = ${org.slug}
      AND created_at >= ${periodStart.toISOString()}::timestamptz
      AND created_at < ${periodEnd.toISOString()}::timestamptz
  `;
  const feedbackCount = (countRows[0]?.count ?? 0) as number;
  if (feedbackCount === 0) return false;

  const leaderRows = await listOrgLeaderRecipients(org.id);
  if (leaderRows.length === 0) return false;

  const insightsResult = await generateInsightsForOrgWindow(org.slug, periodStart, periodEnd).catch((err) => {
    console.error(`[scheduler] Failed to generate insights for ${org.slug}:`, err);
    return null;
  });

  let successCount = 0;
  let lastError: string | null = null;

  for (const leader of leaderRows) {
    try {
      await sendBatchDigest(leader.email, {
        orgName: org.name,
        periodLabel,
        feedbackCount,
        insights: insightsResult?.insights ?? null,
      });
      successCount++;
      console.log(`[scheduler] Sent monthly digest to ${leader.email} (${org.slug})`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed to send to ${leader.email}:`, err);
    }
  }

  const status = successCount > 0 ? "sent" : "failed";
  await sql`
    INSERT INTO reporting.batch_deliveries (
      org_id,
      recipient_count,
      feedback_count,
      period_start,
      period_end,
      status,
      error
    )
    VALUES (
      ${org.id},
      ${successCount},
      ${feedbackCount},
      ${periodStart.toISOString()}::timestamptz,
      ${periodEnd.toISOString()}::timestamptz,
      ${status},
      ${lastError}
    )
  `;

  return status === "sent";
}
