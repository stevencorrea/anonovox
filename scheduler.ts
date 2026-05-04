import { refreshInsights } from "./insights";
import { sendBatchDigest } from "./mailer";

// How many hours must pass between batch digests for an org (23h = nightly cadence)
const BATCH_INTERVAL_HOURS = 23;
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

async function runBatchJobOnce() {
  console.log("[scheduler] Running nightly batch job…");
  try {
    // All orgs that have at least one admin/owner member with an email
    const orgs = await Bun.sql`
      SELECT DISTINCT o.id, o.name, o.slug
      FROM "organization" o
      JOIN "member" m ON m."organizationId" = o.id
      JOIN "user" u ON u.id = m."userId"
      WHERE m.role IN ('owner', 'admin')
      AND u.email IS NOT NULL
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
  // Check when we last sent a batch for this org
  const lastRows = await Bun.sql`
    SELECT sent_at FROM reporting.batch_deliveries
    WHERE org_id = ${org.id} AND status = 'sent'
    ORDER BY sent_at DESC LIMIT 1
  `;

  const lastSentAt = lastRows[0]?.sent_at ? new Date(lastRows[0].sent_at as string) : null;
  const hoursSinceLast = lastSentAt
    ? (Date.now() - lastSentAt.getTime()) / (1000 * 60 * 60)
    : Infinity;

  if (hoursSinceLast < BATCH_INTERVAL_HOURS) return false;

  // Count new feedback since the last batch (or all-time if none)
  const since = lastSentAt ?? new Date(0);
  const countRows = await Bun.sql`
    SELECT COUNT(*)::int AS count FROM reporting.feedback_responses
    WHERE org_domain = ${org.slug}
    AND created_at > ${since.toISOString()}::timestamptz
  `;
  const feedbackCount = (countRows[0]?.count ?? 0) as number;
  if (feedbackCount === 0) return false;

  // Get all admin/owner emails for this org
  const adminRows = await Bun.sql`
    SELECT DISTINCT u.email, u.name FROM "user" u
    JOIN "member" m ON m."userId" = u.id
    WHERE m."organizationId" = ${org.id}
    AND m.role IN ('owner', 'admin')
    AND u.email IS NOT NULL
  `;
  if (adminRows.length === 0) return false;

  // Refresh insights with latest feedback
  const insightsResult = await refreshInsights(org.id, org.slug).catch((err) => {
    console.error(`[scheduler] Failed to generate insights for ${org.slug}:`, err);
    return null;
  });

  // Send to each admin
  let successCount = 0;
  let lastError: string | null = null;

  for (const admin of adminRows as { email: string; name: string }[]) {
    try {
      await sendBatchDigest(admin.email, {
        orgName: org.name,
        feedbackCount,
        insights: insightsResult?.insights ?? null,
      });
      successCount++;
      console.log(`[scheduler] Sent digest to ${admin.email} (${org.slug})`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed to send to ${admin.email}:`, err);
    }
  }

  // Record the delivery regardless of individual send results
  const status = successCount > 0 ? "sent" : "failed";
  await Bun.sql`
    INSERT INTO reporting.batch_deliveries (org_id, recipient_count, feedback_count, status, error)
    VALUES (${org.id}, ${successCount}, ${feedbackCount}, ${status}, ${lastError})
  `;

  return status === "sent";
}
