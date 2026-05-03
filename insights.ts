import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface InsightsResult {
  themes: string[];
  sentiment: { positive: number; neutral: number; negative: number };
  key_quotes: string[];
  overall_summary: string;
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
  const userMessage = `Analyze these ${items.length} anonymous feedback submissions:\n\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n\n")}`;
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const content = message.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type");
  const raw = content.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(raw) as InsightsResult;
}

export async function getCachedInsights(orgId: string): Promise<{ insights: InsightsResult; generated_at: string } | null> {
  const rows = await Bun.sql`
    SELECT content, generated_at FROM reporting.org_insights WHERE org_id = ${orgId}
  `;
  if (!rows.length) return null;
  const row = rows[0];
  const age = Date.now() - new Date(row.generated_at).getTime();
  if (age > CACHE_TTL_MS) return null;
  return { insights: row.content as InsightsResult, generated_at: row.generated_at };
}

export async function refreshInsights(orgId: string, orgDomain: string): Promise<{ insights: InsightsResult; generated_at: string } | null> {
  const rows = await Bun.sql`
    SELECT content FROM reporting.feedback_responses
    WHERE org_domain = ${orgDomain}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  if (!rows.length) return null;
  const items = rows.map((r: { content: string }) => r.content);
  const insights = await generateInsights(items);
  const now = new Date().toISOString();
  await Bun.sql`
    INSERT INTO reporting.org_insights (org_id, content, generated_at)
    VALUES (${orgId}, ${JSON.stringify(insights)}::jsonb, ${now}::timestamptz)
    ON CONFLICT (org_id) DO UPDATE SET content = EXCLUDED.content, generated_at = EXCLUDED.generated_at
  `;
  return { insights, generated_at: now };
}
