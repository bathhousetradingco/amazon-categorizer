import { assertEquals } from "jsr:@std/assert";
import { daysAgo, toAmazonBusinessReportDateTime, toIsoDate } from "./amazon-business-dates.ts";

Deno.test("toAmazonBusinessReportDateTime keeps past end dates at end of day", () => {
  assertEquals(
    toAmazonBusinessReportDateTime("2026-04-20", "end", new Date("2026-04-21T13:45:00Z")),
    "2026-04-20T23:59:59Z",
  );
});

Deno.test("toAmazonBusinessReportDateTime clamps current-day end dates before now", () => {
  assertEquals(
    toAmazonBusinessReportDateTime("2026-04-21", "end", new Date("2026-04-21T13:45:00Z")),
    "2026-04-21T13:40:00Z",
  );
});

Deno.test("toAmazonBusinessReportDateTime writes start dates at midnight", () => {
  assertEquals(
    toAmazonBusinessReportDateTime("2026-04-21", "start", new Date("2026-04-21T13:45:00Z")),
    "2026-04-21T00:00:00Z",
  );
});

Deno.test("daysAgo uses UTC calendar dates", () => {
  assertEquals(toIsoDate(daysAgo(120, new Date("2026-04-21T13:45:00Z"))), "2025-12-22");
});
