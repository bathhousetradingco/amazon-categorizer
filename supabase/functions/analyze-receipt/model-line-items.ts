import { normalizeProductNumber } from "./line-item-parser.ts";
import type { ParsedReceiptItem } from "./parser-types.ts";

export function normalizeModelReceiptItems(input: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(input)) return [];

  const usedProductNumbers = new Set<string>();
  const parsedItems: ParsedReceiptItem[] = [];

  input.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const receiptLabel = cleanModelLabel(
      record.description ||
        record.receipt_label ||
        record.product_name ||
        record.name ||
        record.item_name,
    );
    if (!receiptLabel || isNonProductLineLabel(receiptLabel)) return;

    const quantity = normalizePositiveNumber(record.quantity, 1);
    const totalPrice = normalizePositiveNumber(
      record.total_price ?? record.line_total ?? record.total ?? record.amount,
      Number.NaN,
    );
    if (!Number.isFinite(totalPrice) || totalPrice <= 0) return;

    const unitPrice = normalizePositiveNumber(record.unit_price, totalPrice / quantity);
    const modelProductNumber = normalizeProductNumber(String(record.product_number || record.item_number || record.sku || ""));
    const productNumber = uniqueProductNumber(
      modelProductNumber || `model-line-${index + 1}`,
      usedProductNumbers,
    );

    parsedItems.push({
      product_number: productNumber,
      identifier_type: modelProductNumber ? "item_number" : "unknown",
      quantity,
      unit_price: roundMoney(unitPrice),
      total_price: roundMoney(totalPrice),
      receipt_label: receiptLabel,
      raw_lines: [cleanModelLabel(record.raw_text || record.raw_line || receiptLabel)].filter(Boolean),
      parser_confidence: "low",
    });
  });

  return parsedItems;
}

function cleanModelLabel(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .trim();
}

function isNonProductLineLabel(value: string): boolean {
  return /^(sub\s*total|subtotal|tax|total|tip|change|cash|credit|debit|visa|mastercard|amex|payment|balance)$/i
    .test(value.trim());
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueProductNumber(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;

  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  used.add(candidate);
  return candidate;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
