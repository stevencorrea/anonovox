import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export interface ReviewSuggestion {
  category:
    | "tone"
    | "clarity"
    | "actionability"
    | "specificity"
    | "professionalism";
  original: string;
  suggestion: string;
  explanation: string;
}

export interface ReviewResult {
  suggestions: ReviewSuggestion[];
  overall: string;
  source: "llm";
}

const SYSTEM_PROMPT = `You are an expert writing coach helping employees craft anonymous feedback for leadership. Your job is to review their draft and suggest improvements around tone, clarity, actionability, and professionalism.

Rules:
- The feedback is anonymous — never suggest adding identifying details.
- Focus on making the feedback constructive and likely to be acted upon.
- Keep suggestions concise and practical.
- Return 1-4 suggestions, only where meaningful improvement is possible.
- If the feedback is already well-written, return fewer or no suggestions.

Respond with ONLY valid JSON matching this exact schema:
{
  "suggestions": [
    {
      "category": "tone" | "clarity" | "actionability" | "specificity" | "professionalism",
      "original": "the phrase or sentence to improve",
      "suggestion": "the improved version",
      "explanation": "brief reason for the change"
    }
  ],
  "overall": "one sentence summary of the feedback quality"
}`;

export async function reviewDraft(text: string): Promise<ReviewResult> {
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Review this anonymous feedback draft:\n\n${text}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") {
    return { suggestions: [], overall: "Unable to review.", source: "llm" };
  }

  const parsed = JSON.parse(content.text) as {
    suggestions: ReviewSuggestion[];
    overall: string;
  };

  return {
    suggestions: parsed.suggestions,
    overall: parsed.overall,
    source: "llm",
  };
}
