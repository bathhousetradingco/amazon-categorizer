export type ReceiptTotals = {
  tax: number | null;
  subtotal: number | null;
  receiptTotal: number | null;
};

type ReceiptSubtotalItem = {
  total_price?: number;
  instant_savings_discount?: number;
};

const MAX_INFERRED_TAX_RATE = 0.25;

export function parseReceiptTotals(rawReceiptText: string): ReceiptTotals {
  const totals: ReceiptTotals = {
    tax: null,
    subtotal: null,
    receiptTotal: null,
  };
  const lines = normalizeReceiptLines(rawReceiptText);

  let taxSumCents = 0;
  let foundTax = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trailingAmountCents = parseTrailingCurrencyToCents(line);
    const tableTotals = parseTotalsTableRow(line, lines[index + 1]);

    if (tableTotals) {
      totals.subtotal = centsToAmount(tableTotals.subtotalCents);
      taxSumCents += tableTotals.taxCents;
      foundTax = true;
      totals.receiptTotal = centsToAmount(tableTotals.totalCents);
      if (!parseCurrencyAmountsToCents(line).length) index += 1;
      continue;
    }

    if (isSubtotalLine(line) && Number.isFinite(trailingAmountCents)) {
      totals.subtotal = centsToAmount(trailingAmountCents);
      continue;
    }

    if (isTaxLine(line) && Number.isFinite(trailingAmountCents)) {
      taxSumCents += trailingAmountCents as number;
      foundTax = true;
      continue;
    }

    if (isReceiptTotalLine(line) && Number.isFinite(trailingAmountCents)) {
      totals.receiptTotal = centsToAmount(trailingAmountCents);
    }
  }

  totals.tax = foundTax ? centsToAmount(taxSumCents) : null;
  return totals;
}

export function completeReceiptTotals(
  totals: ReceiptTotals,
  parsedItems: ReceiptSubtotalItem[] = [],
): ReceiptTotals {
  const safeTotals = {
    tax: normalizeNullableAmount(totals?.tax),
    subtotal: normalizeNullableAmount(totals?.subtotal),
    receiptTotal: normalizeNullableAmount(totals?.receiptTotal),
  };
  const parsedSubtotal = sumParsedItems(parsedItems);
  const inferredTax = inferMissingReceiptTax(safeTotals, parsedSubtotal);
  const tax = safeTotals.tax ?? inferredTax ?? 0;
  const subtotalFromTotal =
    safeTotals.receiptTotal !== null && Number.isFinite(tax)
      ? roundMoney(safeTotals.receiptTotal - tax)
      : null;
  const subtotalMissingOrClearlyWrong = safeTotals.subtotal === null ||
    (safeTotals.subtotal === 0 && (
      (parsedSubtotal !== null && parsedSubtotal > 0) ||
      (subtotalFromTotal !== null && subtotalFromTotal > 0)
    ));

  if (!subtotalMissingOrClearlyWrong) {
    return {
      ...safeTotals,
      tax: safeTotals.tax ?? inferredTax,
    };
  }

  return {
    ...safeTotals,
    tax: safeTotals.tax ?? inferredTax,
    subtotal: parsedSubtotal ?? subtotalFromTotal ?? safeTotals.subtotal,
  };
}

function inferMissingReceiptTax(
  totals: ReceiptTotals,
  parsedSubtotal: number | null,
): number | null {
  if (totals.tax !== null) return null;

  const receiptTotalCents = toCents(totals.receiptTotal);
  if (!Number.isFinite(receiptTotalCents)) return null;

  const subtotalBasis = totals.subtotal !== null && totals.subtotal > 0
    ? totals.subtotal
    : parsedSubtotal;
  const subtotalBasisCents = toCents(subtotalBasis);
  if (
    !Number.isFinite(subtotalBasisCents) || (subtotalBasisCents as number) <= 0
  ) {
    return null;
  }

  const inferredTaxCents = (receiptTotalCents as number) -
    (subtotalBasisCents as number);
  if (inferredTaxCents <= 0) return null;
  if (
    inferredTaxCents >
      Math.round((subtotalBasisCents as number) * MAX_INFERRED_TAX_RATE)
  ) {
    return null;
  }

  return centsToAmount(inferredTaxCents);
}

export function parseReceiptInstantSavingsTotal(
  rawReceiptText: string,
): number {
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
  const amounts = parseCurrencyAmountsToCents(line);
  return amounts[amounts.length - 1] ?? null;
}

function parseCurrencyAmountsToCents(line: string): number[] {
  return [
    ...String(line || "").trim().matchAll(
      /(?:USD\s*)?\$?\s*(\d[\d,]*\.\d{2})(?:\s*USD)?/gi,
    ),
  ]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((amount) => Number.isFinite(amount))
    .map((amount) => Math.round(amount * 100));
}

function parseTotalsTableRow(
  line: string,
  nextLine?: string,
): { subtotalCents: number; taxCents: number; totalCents: number } | null {
  if (
    !/\bSUB\s*TOTAL\b/i.test(line) || !/\bTAX\b/i.test(line) ||
    !/\bTOTAL\b/i.test(line)
  ) {
    return null;
  }

  const lineAmounts = parseCurrencyAmountsToCents(line);
  const amounts = lineAmounts.length >= 3
    ? lineAmounts
    : parseCurrencyAmountsToCents(nextLine || "");
  if (amounts.length < 3) return null;

  return {
    subtotalCents: amounts[amounts.length - 3],
    taxCents: amounts[amounts.length - 2],
    totalCents: amounts[amounts.length - 1],
  };
}

function isSubtotalLine(line: string): boolean {
  return /^\s*sub\s*total\b/i.test(line);
}

function isTaxLine(line: string): boolean {
  return /^\s*(?:sales\s+tax|tax\s+total|tax(?:\s+\d+)?)\s*(?:[:\-]|\$|usd|\d|$)/i
    .test(line);
}

function isReceiptTotalLine(line: string): boolean {
  if (
    /^\s*(?:sub\s*total|tax\s+total|sales\s+tax|tax(?:\s+\d+)?)\b/i.test(line)
  ) return false;
  return /^\s*(?:grand\s+total|order\s+total|total)\b/i.test(line);
}

function sumParsedItems(items: ReceiptSubtotalItem[]): number | null {
  let totalCents = 0;
  let hasItem = false;

  for (const item of items || []) {
    const totalCentsForItem = toCents(item?.total_price);
    if (!Number.isFinite(totalCentsForItem)) continue;

    const discountCents = toCents(item?.instant_savings_discount) || 0;
    totalCents += (totalCentsForItem as number) - discountCents;
    hasItem = true;
  }

  return hasItem ? centsToAmount(totalCents) : null;
}

function normalizeNullableAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? roundMoney(amount) : null;
}

function toCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function centsToAmount(cents: number | null): number | null {
  return Number.isFinite(cents) ? (cents as number) / 100 : null;
}
