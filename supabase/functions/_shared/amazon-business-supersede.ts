export type AmazonOrderLineForMatch = {
  order_id: string;
  order_date: string | null;
  amount: number | null;
};

export type PlaidAmazonCandidate = {
  id: string;
  date: string | null;
  amount: number | null;
  name?: string | null;
  merchant_name?: string | null;
};

export type AmazonPlaidSupersedeMatch = {
  transaction_id: string;
  order_id: string;
  plaid_amount: number;
  order_amount: number;
  difference: number;
  date_delta_days: number;
};

type AmazonOrderGroup = {
  order_id: string;
  order_date: string;
  amount_cents: number;
};

const MATCH_DATE_WINDOW_DAYS = 14;
const MATCH_TOLERANCE_FLOOR_CENTS = 100;
const MATCH_TOLERANCE_PERCENT = 0.03;

export function findAmazonPlaidSupersedeMatches(
  candidates: PlaidAmazonCandidate[],
  orderLines: AmazonOrderLineForMatch[],
): AmazonPlaidSupersedeMatch[] {
  const groups = buildAmazonOrderGroups(orderLines);
  const usedOrderIds = new Set<string>();
  const matches: AmazonPlaidSupersedeMatch[] = [];

  for (const candidate of candidates) {
    if (!isLikelyAmazonPlaidTransaction(candidate)) continue;

    const plaidAmountCents = toCents(candidate.amount);
    const plaidDate = parseDateOnly(candidate.date);
    if (plaidAmountCents === null || !plaidDate) continue;

    const options = groups
      .filter((group) => !usedOrderIds.has(group.order_id))
      .map((group) => {
        const dateDeltaDays = Math.abs(daysBetween(plaidDate, parseDateOnly(group.order_date)!));
        const differenceCents = Math.abs(plaidAmountCents - group.amount_cents);
        const toleranceCents = Math.max(MATCH_TOLERANCE_FLOOR_CENTS, Math.round(plaidAmountCents * MATCH_TOLERANCE_PERCENT));
        return {
          group,
          dateDeltaDays,
          differenceCents,
          toleranceCents,
          score: differenceCents + (dateDeltaDays * 10),
        };
      })
      .filter((option) =>
        option.dateDeltaDays <= MATCH_DATE_WINDOW_DAYS &&
        option.differenceCents <= option.toleranceCents
      )
      .sort((a, b) => a.score - b.score);

    const best = options[0];
    if (!best) continue;
    const second = options[1];
    if (second && second.score === best.score) continue;

    usedOrderIds.add(best.group.order_id);
    matches.push({
      transaction_id: candidate.id,
      order_id: best.group.order_id,
      plaid_amount: centsToMoney(plaidAmountCents),
      order_amount: centsToMoney(best.group.amount_cents),
      difference: centsToMoney(best.differenceCents),
      date_delta_days: best.dateDeltaDays,
    });
  }

  return matches;
}

function buildAmazonOrderGroups(orderLines: AmazonOrderLineForMatch[]): AmazonOrderGroup[] {
  const groups = new Map<string, AmazonOrderGroup>();

  for (const line of orderLines) {
    const orderId = String(line.order_id || "").trim();
    const orderDate = toDateOnly(line.order_date);
    const amountCents = toCents(line.amount);
    if (!orderId || !orderDate || amountCents === null || amountCents <= 0) continue;

    const current = groups.get(orderId) || {
      order_id: orderId,
      order_date: orderDate,
      amount_cents: 0,
    };
    current.amount_cents += amountCents;
    if (orderDate < current.order_date) current.order_date = orderDate;
    groups.set(orderId, current);
  }

  return Array.from(groups.values()).filter((group) => group.amount_cents > 0);
}

function isLikelyAmazonPlaidTransaction(transaction: PlaidAmazonCandidate): boolean {
  const name = normalizeText(transaction.name);
  const merchant = normalizeText(transaction.merchant_name);
  return `${name} ${merchant}`.includes("amazon");
}

function normalizeText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function toDateOnly(value: unknown): string {
  const parsed = parseDateOnly(value);
  return parsed ? parsed.toISOString().slice(0, 10) : "";
}

function parseDateOnly(value: unknown): Date | null {
  const date = new Date(`${String(value || "").slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(left: Date, right: Date): number {
  return Math.round(Math.abs(left.getTime() - right.getTime()) / 86400000);
}

function toCents(value: unknown): number | null {
  const amount = Math.abs(Number(value));
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function centsToMoney(cents: number): number {
  return Math.round(cents) / 100;
}
