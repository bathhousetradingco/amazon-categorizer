import type { ParsedReceiptItem, ReceiptMerchant } from "./parser-types.ts";

export type ReceiptTotals = {
  tax: number | null;
  subtotal: number | null;
  receiptTotal: number | null;
};

export type ReceiptMathSummary = {
  computedSubtotalCents: number;
  parsedSubtotalCents: number | null;
  parsedTaxCents: number | null;
  expectedTotalCents: number | null;
  parsedReceiptTotalCents: number | null;
  subtotalDifferenceCents: number | null;
  totalDifferenceCents: number | null;
};

export type ReceiptLineDiagnostic = {
  index: number;
  product_number: string;
  status: "ok" | "invalid" | "mismatch";
  reason?: string;
  quantity?: number;
  unit_price?: number;
  line_total?: number;
  expected_total?: number;
  difference?: number;
};

export type ReceiptMathValidation = {
  summary: ReceiptMathSummary;
  lineItemDiagnostics: ReceiptLineDiagnostic[];
  hasIssues: boolean;
};

type ValidateReceiptMathInput = {
  merchant: ReceiptMerchant;
  parsedItems: ParsedReceiptItem[];
  receiptTotals: ReceiptTotals;
  itemNumbers?: string[];
  lineItemPrices?: Record<string, number>;
};

export function validateReceiptMathByMerchant(input: ValidateReceiptMathInput): ReceiptMathValidation {
  if (input.merchant === "walmart") {
    return validateWalmartMath(input.parsedItems, input.receiptTotals, input.itemNumbers, input.lineItemPrices);
  }

  return validateDefaultMath(input.parsedItems, input.receiptTotals, input.itemNumbers, input.lineItemPrices);
}

function validateWalmartMath(
  parsedItems: ParsedReceiptItem[],
  receiptTotals: ReceiptTotals,
  itemNumbers: string[] = [],
  lineItemPrices: Record<string, number> = {},
): ReceiptMathValidation {
  // Walmart receipts are commonly single-line items without grouped quantity math.
  return validateDefaultMath(
    parsedItems.map((entry) => ({
      ...entry,
      quantity: Number.isFinite(entry.quantity) && entry.quantity > 0 ? entry.quantity : 1,
      unit_price: Number.isFinite(entry.unit_price) && entry.unit_price > 0 ? entry.unit_price : entry.total_price,
    })),
    receiptTotals,
    itemNumbers,
    lineItemPrices,
  );
}

function validateDefaultMath(
  parsedItems: ParsedReceiptItem[],
  receiptTotals: ReceiptTotals,
  itemNumbers: string[] = [],
  lineItemPrices: Record<string, number> = {},
): ReceiptMathValidation {
  const parsedItemsByProduct = new Map(
    parsedItems.map((entry) => [String(entry?.product_number || "").trim(), entry]),
  );
  const effectiveParsedItems = [
    ...parsedItems.filter((entry) => String(entry?.product_number || "").trim()),
  ];

  itemNumbers.forEach((num) => {
    const normalized = String(num || "").trim();
    if (!normalized || parsedItemsByProduct.has(normalized)) return;

    const fallbackPrice = Number(lineItemPrices[normalized]);
    if (!Number.isFinite(fallbackPrice)) return;

    effectiveParsedItems.push({
      product_number: normalized,
      quantity: 1,
      unit_price: fallbackPrice,
      total_price: fallbackPrice,
    });
  });

  const lineItemDiagnostics: ReceiptLineDiagnostic[] = [];
  let computedSubtotalCents = 0;

  effectiveParsedItems.forEach((entry, index) => {
    const quantity = Number(entry?.quantity || 0);
    const unitPriceCents = toCents(entry?.unit_price);
    const parsedLineTotalCents = toCents(entry?.total_price);

    if (!Number.isFinite(quantity) || !Number.isFinite(unitPriceCents) || !Number.isFinite(parsedLineTotalCents)) {
      lineItemDiagnostics.push({
        index,
        product_number: entry?.product_number || "unknown",
        status: "invalid",
        reason: "non-finite value",
        quantity,
        unit_price: entry?.unit_price,
        line_total: entry?.total_price,
      });
      return;
    }

    const safeUnitPriceCents = unitPriceCents as number;
    const safeParsedLineTotalCents = parsedLineTotalCents as number;
    const expectedLineTotalCents = Math.round(quantity * safeUnitPriceCents);
    const differenceCents = safeParsedLineTotalCents - expectedLineTotalCents;
    const discountCents = toCents(entry?.instant_savings_discount) || 0;

    computedSubtotalCents += safeParsedLineTotalCents - discountCents;

    lineItemDiagnostics.push({
      index,
      product_number: entry.product_number,
      status: differenceCents === 0 ? "ok" : "mismatch",
      ...(differenceCents !== 0 ? { reason: "quantity times unit price does not match parsed total" } : {}),
      quantity,
      unit_price: entry.unit_price,
      line_total: entry.total_price,
      expected_total: centsToAmount(expectedLineTotalCents) ?? undefined,
      difference: centsToAmount(differenceCents) ?? undefined,
    });
  });

  const parsedSubtotalCents = toCents(receiptTotals?.subtotal);
  const parsedTaxCents = toCents(receiptTotals?.tax);
  const parsedReceiptTotalCents = toCents(receiptTotals?.receiptTotal);
  const expectedTotalCents = Number.isFinite(parsedTaxCents)
    ? computedSubtotalCents + (parsedTaxCents as number)
    : null;

  const subtotalDifferenceCents = Number.isFinite(parsedSubtotalCents)
    ? computedSubtotalCents - (parsedSubtotalCents as number)
    : null;
  const totalDifferenceCents = Number.isFinite(expectedTotalCents) && Number.isFinite(parsedReceiptTotalCents)
    ? expectedTotalCents - (parsedReceiptTotalCents as number)
    : null;
  const safeExpectedTotalCents = Number.isFinite(expectedTotalCents) ? (expectedTotalCents as number) : null;

  const summary: ReceiptMathSummary = {
    computedSubtotalCents,
    parsedSubtotalCents,
    parsedTaxCents,
    expectedTotalCents: safeExpectedTotalCents,
    parsedReceiptTotalCents,
    subtotalDifferenceCents,
    totalDifferenceCents,
  };

  return {
    summary,
    lineItemDiagnostics,
    hasIssues: lineItemDiagnostics.some((entry) => entry.status !== "ok")
      || (Number.isFinite(summary.subtotalDifferenceCents) && summary.subtotalDifferenceCents !== 0)
      || (Number.isFinite(summary.totalDifferenceCents) && summary.totalDifferenceCents !== 0),
  };
}

function toCents(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function centsToAmount(cents: number | null): number | null {
  return Number.isFinite(cents) ? (cents as number) / 100 : null;
}
