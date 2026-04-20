export type ReceiptTotals = {
  tax: number | null;
  subtotal: number | null;
  receiptTotal: number | null;
};

export function parseReceiptTotals(rawReceiptText: string): ReceiptTotals {
  const totals: ReceiptTotals = {
    tax: null,
    subtotal: null,
    receiptTotal: null,
  };
  const lines = normalizeReceiptLines(rawReceiptText);

  let taxSumCents = 0;
  let foundTax = false;

  for (const line of lines) {
    const trailingAmountCents = parseTrailingCurrencyToCents(line);

    if (/\bSUB\s*TOTAL\b/i.test(line) && Number.isFinite(trailingAmountCents)) {
      totals.subtotal = centsToAmount(trailingAmountCents);
    }

    if (/\bTAX\b/i.test(line) && Number.isFinite(trailingAmountCents)) {
      taxSumCents += trailingAmountCents as number;
      foundTax = true;
    }

    if (/\bTOTAL\b/i.test(line) && !/\bSUB\s*TOTAL\b/i.test(line) && Number.isFinite(trailingAmountCents)) {
      totals.receiptTotal = centsToAmount(trailingAmountCents);
    }
  }

  totals.tax = foundTax ? centsToAmount(taxSumCents) : null;
  return totals;
}

export function parseReceiptInstantSavingsTotal(rawReceiptText: string): number {
  return normalizeReceiptLines(rawReceiptText).reduce((sum, line) => {
    if (!/^INST\s+SV\b/i.test(line)) return sum;
    const match = line.match(/(\d+\.\d{2})-\s*[A-Z.]*\s*$/i);
    if (!match) return sum;
    const amount = Number(match[1]);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

function normalizeReceiptLines(rawReceiptText: string): string[] {
  return String(rawReceiptText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTrailingCurrencyToCents(line: string): number | null {
  const match = String(line || "").trim().match(/(\d+\.\d{2})\s*[A-Z]?\s*$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function centsToAmount(cents: number | null): number | null {
  return Number.isFinite(cents) ? (cents as number) / 100 : null;
}
