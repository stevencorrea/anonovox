import { test, expect, describe } from "bun:test";
import { analyzeText } from "./analyze";

describe("analyzeText", () => {
  test("returns empty risks for empty input", () => {
    const result = analyzeText("");
    expect(result.risks).toEqual([]);
    expect(result.source).toBe("heuristic");
  });

  test("returns empty risks for whitespace-only input", () => {
    const result = analyzeText("   \n\t  ");
    expect(result.risks).toEqual([]);
  });

  test("returns empty risks for safe text", () => {
    const result = analyzeText("The company culture needs improvement.");
    expect(result.risks).toEqual([]);
  });

  describe("email detection", () => {
    test("detects email address", () => {
      const result = analyzeText("Contact me at john@example.com for details");
      expect(result.risks).toHaveLength(1);
      expect(result.risks[0].type).toBe("email");
      expect(result.risks[0].matchedText).toBe("john@example.com");
      expect(result.risks[0].replacement).toBe("[EMAIL]");
      expect(result.risks[0].confidence).toBe("high");
    });

    test("detects multiple emails", () => {
      const result = analyzeText("Send to alice@corp.com and bob@corp.com");
      const emails = result.risks.filter((r) => r.type === "email");
      expect(emails).toHaveLength(2);
    });
  });

  describe("phone detection", () => {
    test("detects phone with dashes", () => {
      const result = analyzeText("Call me at 555-123-4567");
      const phones = result.risks.filter((r) => r.type === "phone");
      expect(phones).toHaveLength(1);
      expect(phones[0].matchedText).toBe("555-123-4567");
      expect(phones[0].replacement).toBe("[PHONE]");
    });

    test("detects phone with parens", () => {
      const result = analyzeText("My number is (555) 123-4567");
      const phones = result.risks.filter((r) => r.type === "phone");
      expect(phones).toHaveLength(1);
    });

    test("detects phone with country code", () => {
      const result = analyzeText("Reach me at +1-555-123-4567");
      const phones = result.risks.filter((r) => r.type === "phone");
      expect(phones).toHaveLength(1);
    });

    test("does not flag short number sequences", () => {
      const result = analyzeText("There are 1234 employees");
      const phones = result.risks.filter((r) => r.type === "phone");
      expect(phones).toHaveLength(0);
    });
  });

  describe("identifier detection", () => {
    test("detects EMP-12345 format", () => {
      const result = analyzeText("My employee ID is EMP-12345");
      const ids = result.risks.filter((r) => r.type === "identifier");
      expect(ids).toHaveLength(1);
      expect(ids[0].replacement).toBe("[ID]");
    });

    test("detects #12345 format", () => {
      const result = analyzeText("Refer to ticket #12345");
      const ids = result.risks.filter((r) => r.type === "identifier");
      expect(ids).toHaveLength(1);
    });

    test("detects BADGE format", () => {
      const result = analyzeText("My badge 54321 was deactivated");
      const ids = result.risks.filter((r) => r.type === "identifier");
      expect(ids).toHaveLength(1);
    });
  });

  describe("date detection", () => {
    test("detects MM/DD/YYYY", () => {
      const result = analyzeText("This happened on 03/15/2024");
      const dates = result.risks.filter((r) => r.type === "date");
      expect(dates).toHaveLength(1);
      expect(dates[0].replacement).toBe("[DATE]");
    });

    test("detects ISO date", () => {
      const result = analyzeText("The incident was on 2024-03-15");
      const dates = result.risks.filter((r) => r.type === "date");
      expect(dates).toHaveLength(1);
    });

    test("detects named date", () => {
      const result = analyzeText("Since March 15, 2024 things got worse");
      const dates = result.risks.filter((r) => r.type === "date");
      expect(dates).toHaveLength(1);
      expect(dates[0].matchedText).toBe("March 15, 2024");
    });

    test("detects abbreviated month date", () => {
      const result = analyzeText("On Jan 5th the meeting happened");
      const dates = result.risks.filter((r) => r.type === "date");
      expect(dates).toHaveLength(1);
    });
  });

  describe("team detection", () => {
    test("detects team keyword", () => {
      const result = analyzeText("The engineering team is struggling");
      const teams = result.risks.filter((r) => r.type === "team");
      expect(teams).toHaveLength(1);
      expect(teams[0].replacement).toBe("[TEAM]");
    });

    test("detects HR", () => {
      const result = analyzeText("I reported this to hr but nothing happened");
      const teams = result.risks.filter((r) => r.type === "team");
      expect(teams).toHaveLength(1);
    });

    test("detects department suffix", () => {
      const result = analyzeText("The finance department ignores us");
      const teams = result.risks.filter((r) => r.type === "team");
      expect(teams).toHaveLength(1);
    });
  });

  describe("location detection", () => {
    test("detects building reference", () => {
      const result = analyzeText("I work in Building A");
      const locs = result.risks.filter((r) => r.type === "location");
      expect(locs).toHaveLength(1);
      expect(locs[0].replacement).toBe("[LOCATION]");
    });

    test("detects floor reference", () => {
      const result = analyzeText("On floor 3 the noise is unbearable");
      const locs = result.risks.filter((r) => r.type === "location");
      expect(locs).toHaveLength(1);
    });

    test("detects room reference", () => {
      const result = analyzeText("Room 401 has mold issues");
      const locs = result.risks.filter((r) => r.type === "location");
      expect(locs).toHaveLength(1);
    });
  });

  describe("name detection", () => {
    test("detects name after lowercase text", () => {
      const result = analyzeText("I told Sarah Johnson about this issue.");
      const names = result.risks.filter((r) => r.type === "name");
      expect(names).toHaveLength(1);
      expect(names[0].matchedText).toBe("Sarah Johnson");
      expect(names[0].replacement).toBe("[NAME]");
    });

    test("detects name after preposition", () => {
      const result = analyzeText("The report was filed by Michael Chen last week.");
      const names = result.risks.filter((r) => r.type === "name");
      expect(names).toHaveLength(1);
      expect(names[0].matchedText).toBe("Michael Chen");
    });

    test("does not flag common words", () => {
      const result = analyzeText("We should have better management.");
      const names = result.risks.filter((r) => r.type === "name");
      expect(names).toHaveLength(0);
    });
  });

  describe("multiple risks", () => {
    test("detects multiple different risk types", () => {
      const text =
        "I told Sarah Johnson from the engineering team about this on March 15, 2024. Contact john@corp.com";
      const result = analyzeText(text);
      const types = new Set(result.risks.map((r) => r.type));
      expect(types.has("email")).toBe(true);
      expect(types.has("date")).toBe(true);
      expect(types.has("team")).toBe(true);
    });

    test("risks are sorted by startIndex", () => {
      const text = "Email john@a.com and call 555-123-4567 today";
      const result = analyzeText(text);
      for (let i = 1; i < result.risks.length; i++) {
        expect(result.risks[i].startIndex).toBeGreaterThanOrEqual(
          result.risks[i - 1].startIndex,
        );
      }
    });
  });

  describe("index correctness", () => {
    test("startIndex and endIndex match the text position", () => {
      const text = "Send to alice@example.com please";
      const result = analyzeText(text);
      expect(result.risks).toHaveLength(1);
      const risk = result.risks[0];
      expect(text.slice(risk.startIndex, risk.endIndex)).toBe(
        "alice@example.com",
      );
    });
  });
});
