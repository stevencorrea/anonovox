import { expect, test } from "bun:test";
import { getPreviousMonthlyDigestPeriod } from "../src/server/scheduler";

test("getPreviousMonthlyDigestPeriod returns the previous full calendar month", () => {
  const reference = new Date("2026-05-08T12:00:00.000Z");
  const { periodStart, periodEnd, periodLabel } = getPreviousMonthlyDigestPeriod(reference);

  expect(periodStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  expect(periodEnd.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  expect(periodLabel).toBe("April 2026");
});

test("getPreviousMonthlyDigestPeriod handles january year boundaries", () => {
  const reference = new Date("2026-01-03T08:30:00.000Z");
  const { periodStart, periodEnd, periodLabel } = getPreviousMonthlyDigestPeriod(reference);

  expect(periodStart.toISOString()).toBe("2025-12-01T00:00:00.000Z");
  expect(periodEnd.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(periodLabel).toBe("December 2025");
});
