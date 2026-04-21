import type { ParsedReceiptItem, ReceiptParserResult } from "./parser-types.ts";

type ParseMiscReceiptInput = {
  lines: string[];
  transactionName?: string | null;
  merchantName?: string | null;
  modelParsedItems?: ParsedReceiptItem[];
};

export function parseMiscReceipt(
  input: ParseMiscReceiptInput,
): ReceiptParserResult {
  const totalAmount = detectMiscReceiptTotal(input.lines);
  const receiptLabel = buildMiscReceiptLabel(input);
  const structuredChargeItems = extractMiscReceiptChargeRows(
    input.lines,
    totalAmount,
  );

  if (structuredChargeItems.length) {
    return {
      merchant: "misc",
      item_numbers: structuredChargeItems.map((item) => item.product_number),
      parsed_items: structuredChargeItems,
      debug: {
        parser_status: "structured-charge-rows",
        parser_message:
          "Used visible misc receipt charge rows before generic fallback.",
        detected_total: totalAmount,
        detected_label: receiptLabel,
        parsed_item_count: structuredChargeItems.length,
      },
    };
  }

  if (input.modelParsedItems?.length) {
    const parsedItems = shouldUseMerchantAsSingleLineLabel(input)
      ? relabelSingleServiceReceiptItem(input.modelParsedItems, receiptLabel)
      : input.modelParsedItems;

    return {
      merchant: "misc",
      item_numbers: parsedItems.map((item) => item.product_number).filter(
        Boolean,
      ),
      parsed_items: parsedItems,
      debug: {
        parser_status: "openai-line-items",
        parser_message: "Used OpenAI-extracted misc receipt line items.",
        parsed_item_count: parsedItems.length,
      },
    };
  }

  const hasDetectedTotal = Number.isFinite(totalAmount) &&
    (totalAmount as number) > 0;

  const parsedItems: ParsedReceiptItem[] = hasDetectedTotal
    ? [{
      product_number: "misc-receipt-total",
      identifier_type: "unknown",
      quantity: 1,
      unit_price: totalAmount as number,
      total_price: totalAmount as number,
      receipt_label: receiptLabel,
      line_index: 0,
      raw_lines: input.lines.slice(0, 5),
      parser_confidence: "medium",
    }]
    : [];

  return {
    merchant: "misc",
    item_numbers: parsedItems.length ? ["misc-receipt-total"] : [],
    parsed_items: parsedItems,
    debug: {
      parser_status: parsedItems.length ? "generic-fallback" : "stub",
      parser_message: parsedItems.length
        ? "Used generic misc receipt fallback item."
        : "No merchant-specific parser matched this receipt.",
      detected_total: totalAmount,
      detected_label: receiptLabel,
    },
  };
}

function buildMiscReceiptLabel(input: ParseMiscReceiptInput): string {
  const merchant = String(input.merchantName || "").trim();
  const transaction = String(input.transactionName || "").trim();
  const firstContentLine = input.lines
    .map((line) => String(line || "").trim())
    .find((line) => line.length >= 3 && !/\d+\.\d{2}/.test(line));

  return merchant || transaction || firstContentLine || "Misc receipt";
}

function shouldUseMerchantAsSingleLineLabel(
  input: ParseMiscReceiptInput,
): boolean {
  if (input.modelParsedItems?.length !== 1) return false;

  const merchantText = `${input.merchantName || ""} ${
    input.transactionName || ""
  }`.toLowerCase();
  return /\b(patreon|shopify|google workspace|cricut|gfl|minutekey|minute\s*key)\b/
    .test(merchantText);
}

function relabelSingleServiceReceiptItem(
  items: ParsedReceiptItem[],
  merchantLabel: string,
): ParsedReceiptItem[] {
  const item = items[0];
  const originalLabel = String(item?.receipt_label || "").trim();
  const cleanMerchantLabel = String(merchantLabel || "").trim();

  if (!item || !cleanMerchantLabel) return items;

  return [{
    ...item,
    receipt_label: cleanMerchantLabel,
    raw_lines: [
      ...(Array.isArray(item.raw_lines) ? item.raw_lines : []),
      originalLabel && originalLabel !== cleanMerchantLabel
        ? `Receipt description: ${originalLabel}`
        : "",
    ].filter(Boolean),
  }];
}

function extractMiscReceiptChargeRows(
  lines: string[],
  receiptTotal: number | null,
): ParsedReceiptItem[] {
  const usedProductNumbers = new Set<string>();
  const candidates: ParsedReceiptItem[] = [];

  (lines || []).forEach((line, index) => {
    const rawLine = String(line || "").trim();
    if (!rawLine) return;

    const amountMatches = parseCurrencyAmountMatches(rawLine);
    if (amountMatches.length !== 1) return;

    const amount = amountMatches[0].amount;
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (Number.isFinite(receiptTotal) && amount === receiptTotal) return;

    const label = cleanStructuredChargeLabel(
      rawLine.slice(0, amountMatches[0].index),
    );
    if (!isUsefulStructuredChargeLabel(label)) return;

    const productNumber = uniqueStructuredProductNumber(
      label,
      usedProductNumbers,
    );
    candidates.push({
      product_number: productNumber,
      identifier_type: "unknown",
      quantity: 1,
      unit_price: amount,
      total_price: amount,
      receipt_label: label,
      line_index: index,
      raw_lines: [rawLine],
      parser_confidence: "medium",
    });
  });

  const positiveTotal =
    Number.isFinite(receiptTotal) && (receiptTotal as number) > 0
      ? receiptTotal as number
      : null;
  const candidateSum = roundMoney(
    candidates.reduce((sum, item) => sum + item.total_price, 0),
  );
  const sumsToReceiptTotal = positiveTotal !== null &&
    Math.abs(candidateSum - positiveTotal) <= 0.02;

  if (
    candidates.length >= 2 && (sumsToReceiptTotal || positiveTotal === null)
  ) {
    return candidates;
  }

  return [];
}

function parseCurrencyAmountMatches(
  line: string,
): Array<{ amount: number; index: number }> {
  return [
    ...String(line || "").matchAll(
      /(?:USD\s*)?\$?\s*(\d[\d,]*\.\d{2})(?:\s*USD)?/gi,
    ),
  ]
    .map((match) => ({
      amount: Number.parseFloat(String(match[1] || "").replace(/,/g, "")),
      index: match.index ?? -1,
    }))
    .filter((entry) => Number.isFinite(entry.amount) && entry.index >= 0);
}

function cleanStructuredChargeLabel(value: string): string {
  return String(value || "")
    .replace(/\([^)]*\bitems?\b[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .trim();
}

function isUsefulStructuredChargeLabel(label: string): boolean {
  const clean = String(label || "").trim();
  if (clean.length < 3) return false;

  if (
    /^(?:sub\s*total|subtotal|total|total\s+due|grand\s+total|order\s+total|balance|balance\s+due|amount\s+due|credit|payment|cash|visa|mastercard|amex|change|messaging)$/i
      .test(clean)
  ) {
    return false;
  }

  if (/^(?:sales\s+tax|tax|tax\s+\d+|tax\s+total)$/i.test(clean)) {
    return false;
  }

  return /[A-Za-z]/.test(clean);
}

function uniqueStructuredProductNumber(
  label: string,
  usedProductNumbers: Set<string>,
): string {
  const baseSlug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "charge";
  const base = `misc-line-${baseSlug}`;
  let candidate = base;
  let suffix = 2;

  while (usedProductNumbers.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  usedProductNumbers.add(candidate);
  return candidate;
}

function detectMiscReceiptTotal(lines: string[]): number | null {
  const normalizedLines = (lines || [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  for (let i = normalizedLines.length - 1; i >= 0; i--) {
    const line = normalizedLines[i];
    if (!/\bTOTAL\b/i.test(line) || /\bSUB\s*TOTAL\b/i.test(line)) continue;
    const amount = parseTrailingAmount(line);
    if (Number.isFinite(amount)) return amount;
  }

  for (let i = normalizedLines.length - 1; i >= 0; i--) {
    const amount = parseTrailingAmount(normalizedLines[i]);
    if (Number.isFinite(amount)) return amount;
  }

  return null;
}

function parseTrailingAmount(line: string): number | null {
  const matches = [
    ...String(line || "").matchAll(
      /(?:USD\s*)?\$?\s*(\d[\d,]*\.\d{2})(?:\s*USD)?/gi,
    ),
  ];
  const match = matches[matches.length - 1];
  if (!match?.[1]) return null;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
