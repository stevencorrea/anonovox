import Anthropic from "@anthropic-ai/sdk";
import type { AnalysisRisk } from "./analyze";

const client = new Anthropic();
const VALID_CATEGORIES = new Set<ReviewSuggestion["category"]>([
  "tone",
  "clarity",
  "actionability",
  "specificity",
  "professionalism",
  "anonymization",
]);

export interface ReviewSuggestion {
  category:
    | "tone"
    | "clarity"
    | "actionability"
    | "specificity"
    | "professionalism"
    | "anonymization";
  original: string;
  suggestion: string;
  explanation: string;
}

export interface ReviewResult {
  suggestions: ReviewSuggestion[];
  overall: string;
  source: "llm";
}

function fallbackReview(overall = "Draft review is unavailable right now."): ReviewResult {
  return { suggestions: [], overall, source: "llm" };
}

function normalizeReviewResult(value: unknown): ReviewResult {
  const parsed = value as {
    suggestions?: Array<Partial<ReviewSuggestion>>;
    overall?: unknown;
  };

  const suggestions = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions.flatMap((suggestion) => {
      if (
        !suggestion
        || typeof suggestion.original !== "string"
        || typeof suggestion.suggestion !== "string"
        || typeof suggestion.explanation !== "string"
        || !VALID_CATEGORIES.has(suggestion.category as ReviewSuggestion["category"])
      ) {
        return [];
      }

      return [{
        category: suggestion.category as ReviewSuggestion["category"],
        original: suggestion.original.trim(),
        suggestion: suggestion.suggestion.trim(),
        explanation: suggestion.explanation.trim(),
      }];
    }).slice(0, 4)
    : [];

  return {
    suggestions,
    overall: typeof parsed?.overall === "string" ? parsed.overall.trim() : "",
    source: "llm",
  };
}

const SYSTEM_PROMPT = `You are an expert writing coach helping employees craft anonymous feedback for leadership. Your job is to review their draft and suggest improvements around tone, clarity, actionability, and professionalism.

Rules:
- The feedback is anonymous — never suggest adding identifying details.
- Focus on making the feedback constructive and likely to be acted upon.
- Keep suggestions concise and practical.
- Return 1-4 suggestions, only where meaningful improvement is possible.
- If the feedback is already well-written, return fewer or no suggestions.
- Also check for implicit identity signals that heuristics may miss: unique project names, unusual role descriptions, rare events, or anything that could narrow down who wrote this even without explicit PII. Suggest neutral rewrites using the category "anonymization".

Respond with ONLY valid JSON matching this exact schema:
{
  "suggestions": [
    {
      "category": "tone" | "clarity" | "actionability" | "specificity" | "professionalism" | "anonymization",
      "original": "the phrase or sentence to improve",
      "suggestion": "the improved version",
      "explanation": "brief reason for the change"
    }
  ],
  "overall": "one sentence summary of the feedback quality"
}`;

export async function reviewDraft(text: string, risks?: AnalysisRisk[]): Promise<ReviewResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return fallbackReview();
  }

  const risksContext = risks?.length
    ? `\n\nAlready flagged by heuristics (don't repeat these): ${risks.map((r) => `"${r.matchedText}" (${r.type})`).join(", ")}. Focus on implicit risks the list above may miss.`
    : "";
  const userMessage = `Review this anonymous feedback draft:\n\n${text}${risksContext}`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  const content = message.content[0];
  if (!content) {
    return { suggestions: [], overall: "Unable to review.", source: "llm" };
  }
  if (content.type !== "text") {
    return { suggestions: [], overall: "Unable to review.", source: "llm" };
  }

  const raw = content.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return normalizeReviewResult(JSON.parse(raw));
  } catch {
    return fallbackReview("Draft review completed, but the response could not be parsed.");
  }
}
