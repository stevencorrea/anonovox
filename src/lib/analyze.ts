export type RiskType =
  | "name"
  | "email"
  | "phone"
  | "date"
  | "team"
  | "location"
  | "identifier";

export interface AnalysisRisk {
  type: RiskType;
  label: string;
  matchedText: string;
  startIndex: number;
  endIndex: number;
  replacement: string;
  confidence: "high" | "medium";
}

export interface AnalysisResult {
  risks: AnalysisRisk[];
  source: "heuristic";
}

const TEAM_KEYWORDS = [
  "engineering",
  "marketing",
  "sales",
  "product",
  "design",
  "hr",
  "human resources",
  "finance",
  "legal",
  "operations",
  "support",
  "qa",
  "devops",
  "data science",
  "infrastructure",
  "accounting",
  "compliance",
  "security",
  "platform",
  "mobile",
  "frontend",
  "backend",
  "customer success",
  "people ops",
  "recruiting",
];

const COMMON_WORDS = new Set([
  // Days & months (handled by date detector)
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  // Common sentence starters / generic capitalized words
  "the", "this", "that", "these", "those", "they", "their", "there",
  "what", "when", "where", "which", "while", "who", "why", "how",
  "also", "just", "very", "really", "about", "after", "before",
  "company", "team", "management", "leadership", "department",
  "please", "thank", "thanks", "sorry", "hello", "dear",
  "good", "great", "best", "better", "worst", "worse",
  "new", "old", "first", "last", "next",
  "our", "your", "every", "some", "many", "most", "other",
  "been", "being", "have", "having", "would", "could", "should",
  "will", "shall", "might",
  "not", "but", "and", "for", "with", "from",
]);

interface RawMatch {
  type: RiskType;
  label: string;
  matchedText: string;
  startIndex: number;
  endIndex: number;
  replacement: string;
  confidence: "high" | "medium";
}

function collectMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];

  // Email detection
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  for (const m of text.matchAll(emailRe)) {
    matches.push({
      type: "email",
      label: "Email address detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[EMAIL]",
      confidence: "high",
    });
  }

  // Phone detection (NA formats)
  const phoneRe =
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g;
  for (const m of text.matchAll(phoneRe)) {
    // Only flag if it looks like a real phone number (at least 10 digits)
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 10) {
      matches.push({
        type: "phone",
        label: "Phone number detected",
        matchedText: m[0],
        startIndex: m.index!,
        endIndex: m.index! + m[0].length,
        replacement: "[PHONE]",
        confidence: "high",
      });
    }
  }

  // Identifier detection (EMP-12345, #12345, ID: 12345, badge 12345)
  const idRe =
    /\b(?:EMP|ID|BADGE|EMPLOYEE)[-:\s]?\s*#?\d{3,}\b/gi;
  for (const m of text.matchAll(idRe)) {
    matches.push({
      type: "identifier",
      label: "Employee/badge identifier detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[ID]",
      confidence: "high",
    });
  }

  // Standalone # identifiers like #12345
  const hashIdRe = /(?<!\w)#\d{3,}\b/g;
  for (const m of text.matchAll(hashIdRe)) {
    matches.push({
      type: "identifier",
      label: "Numeric identifier detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[ID]",
      confidence: "high",
    });
  }

  // Date detection
  // MM/DD/YYYY or DD/MM/YYYY or YYYY-MM-DD
  const dateSlashRe = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g;
  for (const m of text.matchAll(dateSlashRe)) {
    matches.push({
      type: "date",
      label: "Specific date detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[DATE]",
      confidence: "medium",
    });
  }

  // ISO dates: 2024-01-15
  const isoDateRe = /\b\d{4}-\d{2}-\d{2}\b/g;
  for (const m of text.matchAll(isoDateRe)) {
    matches.push({
      type: "date",
      label: "Specific date detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[DATE]",
      confidence: "medium",
    });
  }

  // Named dates: January 15, Jan 15 2024, March 3rd, etc.
  const namedDateRe =
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:[,\s]+\d{4})?\b/gi;
  for (const m of text.matchAll(namedDateRe)) {
    matches.push({
      type: "date",
      label: "Specific date detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[DATE]",
      confidence: "medium",
    });
  }

  // Team/department detection
  const lowerText = text.toLowerCase();
  for (const keyword of TEAM_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}(?:\\s+(?:team|dept|department|group|org))?\\b`, "gi");
    for (const m of lowerText.matchAll(re)) {
      // Get the original-cased text from the source
      const original = text.slice(m.index!, m.index! + m[0].length);
      matches.push({
        type: "team",
        label: "Team/department name detected",
        matchedText: original,
        startIndex: m.index!,
        endIndex: m.index! + m[0].length,
        replacement: "[TEAM]",
        confidence: "medium",
      });
    }
  }

  // Location detection: Building X, Floor N, Room NNN
  const locationRe =
    /\b(?:building|floor|room|office|campus|site|wing)\s+[A-Z0-9][\w-]*/gi;
  for (const m of text.matchAll(locationRe)) {
    matches.push({
      type: "location",
      label: "Location reference detected",
      matchedText: m[0],
      startIndex: m.index!,
      endIndex: m.index! + m[0].length,
      replacement: "[LOCATION]",
      confidence: "medium",
    });
  }

  // Name detection: 2-3 consecutive capitalized words not at sentence start
  const nameRe = /(?<=[a-z.,!?;:]\s+|\b(?:with|by|from|to|told|asked|named|called|met|cc|CC)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g;
  for (const m of text.matchAll(nameRe)) {
    const name = m[1] || m[0];
    const words = name.toLowerCase().split(/\s+/);
    // Skip if all words are common words
    if (words.every((w) => COMMON_WORDS.has(w))) continue;
    const idx = m.index! + (m[0].length - name.length);
    matches.push({
      type: "name",
      label: "Possible personal name detected",
      matchedText: name,
      startIndex: idx,
      endIndex: idx + name.length,
      replacement: "[NAME]",
      confidence: "medium",
    });
  }

  return matches;
}

function deduplicateAndSort(matches: RawMatch[]): AnalysisRisk[] {
  // Sort by startIndex, then by span length descending (prefer longer matches)
  matches.sort((a, b) => a.startIndex - b.startIndex || (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex));

  const result: AnalysisRisk[] = [];
  let lastEnd = -1;

  for (const match of matches) {
    // Skip if this match overlaps with the previous kept match
    if (match.startIndex < lastEnd) continue;
    result.push({
      type: match.type,
      label: match.label,
      matchedText: match.matchedText,
      startIndex: match.startIndex,
      endIndex: match.endIndex,
      replacement: match.replacement,
      confidence: match.confidence,
    });
    lastEnd = match.endIndex;
  }

  return result;
}

export function analyzeText(text: string): AnalysisResult {
  if (!text.trim()) {
    return { risks: [], source: "heuristic" };
  }

  const matches = collectMatches(text);
  const risks = deduplicateAndSort(matches);

  return { risks, source: "heuristic" };
}
