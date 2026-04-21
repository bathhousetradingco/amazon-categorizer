const AMAZON_REPORT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function toAmazonBusinessReportDateTime(
  value: string | Date,
  boundary: "start" | "end",
  now = new Date(),
): string {
  const dateOnly = toIsoDate(value);
  if (!dateOnly) return "";
  if (boundary === "start") return `${dateOnly}T00:00:00Z`;

  const requestedEnd = new Date(`${dateOnly}T23:59:59Z`);
  const safeNow = new Date(now.getTime() - AMAZON_REPORT_CLOCK_SKEW_MS);
  const end = requestedEnd.getTime() > safeNow.getTime() ? safeNow : requestedEnd;
  return toSecondPrecisionIso(end);
}

export function toIsoDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(`${String(value || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function daysAgo(days: number, now = new Date()): Date {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function toSecondPrecisionIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
