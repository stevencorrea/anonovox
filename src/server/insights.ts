import Anthropic from "@anthropic-ai/sdk";
import { sql } from "./db";

const client = new Anthropic();
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface InsightsResult {
  themes: string[];
  sentiment: { positive: number; neutral: number; negative: number };
  key_quotes: string[];
  overall_summary: string;
}

function normalizePercent(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeInsightsResult(value: unknown): InsightsResult {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      source = {};
    }
  }

  const parsed = source as {
    themes?: unknown;
    sentiment?: { positive?: unknown; neutral?: unknown; negative?: unknown };
    key_quotes?: unknown;
    overall_summary?: unknown;
  };

  const positive = normalizePercent(parsed?.sentiment?.positive);
  const neutral = normalizePercent(parsed?.sentiment?.neutral);
  const negative = Math.max(0, 100 - positive - neutral);

  return {
    themes: Array.isArray(parsed?.themes)
      ? parsed.themes.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 6)
      : [],
    sentiment: { positive, neutral, negative },
    key_quotes: Array.isArray(parsed?.key_quotes)
      ? parsed.key_quotes.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 4)
      : [],
    overall_summary: typeof parsed?.overall_summary === "string" ? parsed.overall_summary.trim() : "",
  };
}

const SYSTEM_PROMPT = `You are analyzing anonymous employee feedback for a leadership team. Synthesize the submissions into structured insights.

Respond with ONLY valid JSON matching this exact schema:
{
  "themes": ["2-6 short theme labels"],
  "sentiment": { "positive": <0-100>, "neutral": <0-100>, "negative": <0-100> },
  "key_quotes": ["2-4 representative verbatim quotes under 120 chars each"],
  "overall_summary": "2-3 sentence synthesis for leadership"
}
The three sentiment numbers must sum to 100.`;

async function generateInsights(items: string[]): Promise<InsightsResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const userMessage = `Analyze these ${items.length} anonymous feedback submissions:\n\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}`;
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const content = message.content[0];
  if (!content) throw new Error("No content returned from insights model");
  if (content.type !== "text") throw new Error("Unexpected response type");
  const raw = content.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return normalizeInsightsResult(JSON.parse(raw));
}

export async function generateInsightsForOrgWindow(
  orgDomain: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ insights: InsightsResult; sampleCount: number } | null> {
  const rows = await sql`
    SELECT content FROM reporting.feedback_responses
    WHERE org_domain = ${orgDomain}
      AND created_at >= ${windowStart.toISOString()}::timestamptz
      AND created_at < ${windowEnd.toISOString()}::timestamptz
    ORDER BY created_at DESC
    LIMIT 50
  ` as Array<{ content: string }>;

  if (!rows.length) return null;

  const items = rows.map((row) => row.content);
  const insights = await generateInsights(items);
  return { insights, sampleCount: items.length };
}

export async function getCachedInsights(orgId: string): Promise<{ insights: InsightsResult; generated_at: string } | null> {
  const rows = await sql`
    SELECT content, generated_at FROM reporting.org_insights WHERE org_id = ${orgId}
  `;
  if (!rows.length) return null;
  const row = rows[0];
  const age = Date.now() - new Date(row.generated_at).getTime();
  if (age > CACHE_TTL_MS) return null;
  return { insights: normalizeInsightsResult(row.content), generated_at: row.generated_at };
}

export async function refreshInsights(orgId: string, orgDomain: string): Promise<{ insights: InsightsResult; generated_at: string } | null> {
  const rows = await sql`
    SELECT content FROM reporting.feedback_responses
    WHERE org_domain = ${orgDomain}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  if (!rows.length) return null;
  const items = rows.map((r: { content: string }) => r.content);
  const insights = await generateInsights(items);
  const now = new Date().toISOString();
  await Promise.all([
    sql`
      INSERT INTO reporting.org_insights (org_id, content, generated_at)
      VALUES (${orgId}, ${JSON.stringify(insights)}::jsonb, ${now}::timestamptz)
      ON CONFLICT (org_id) DO UPDATE SET content = EXCLUDED.content, generated_at = EXCLUDED.generated_at
    `,
    sql`
      INSERT INTO reporting.insights_history (org_id, content, feedback_count, generated_at)
      VALUES (${orgId}, ${JSON.stringify(insights)}::jsonb, ${items.length}, ${now}::timestamptz)
    `,
  ]);
  return { insights, generated_at: now };
}

export interface InsightsDelta {
  sentiment: { positive: number; neutral: number; negative: number };
  newThemes: string[];
  droppedThemes: string[];
}

export async function getInsightsDelta(orgId: string, current: InsightsResult): Promise<InsightsDelta | null> {
  const rows = await sql`
    SELECT content FROM reporting.insights_history
    WHERE org_id = ${orgId}
    ORDER BY generated_at DESC
    LIMIT 2
  ` as Array<{ content: InsightsResult }>;
  const previousRow = rows[1];
  if (!previousRow) return null;
  const prev = normalizeInsightsResult(previousRow.content);
  const currentThemes = new Set(current.themes);
  const prevThemes = new Set(prev.themes);
  return {
    sentiment: {
      positive: current.sentiment.positive - prev.sentiment.positive,
      neutral: current.sentiment.neutral - prev.sentiment.neutral,
      negative: current.sentiment.negative - prev.sentiment.negative,
    },
    newThemes: current.themes.filter((t) => !prevThemes.has(t)),
    droppedThemes: prev.themes.filter((t) => !currentThemes.has(t)),
  };
}

export async function getInsightsHistory(orgId: string, limit = 10): Promise<Array<{ id: string; insights: InsightsResult; feedback_count: number; generated_at: string }>> {
  const rows = await sql`
    SELECT id, content, feedback_count, generated_at
    FROM reporting.insights_history
    WHERE org_id = ${orgId}
    ORDER BY generated_at DESC
    LIMIT ${limit}
  ` as Array<{ id: string; content: unknown; feedback_count: number; generated_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    insights: normalizeInsightsResult(r.content),
    feedback_count: r.feedback_count,
    generated_at: r.generated_at,
  }));
}
