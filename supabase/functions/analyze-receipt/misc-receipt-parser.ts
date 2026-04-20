import type { ParsedReceiptItem, ReceiptParserResult } from "./parser-types.ts";

type ParseMiscReceiptInput = {
  lines: string[];
  transactionName?: string | null;
  merchantName?: string | null;
  modelParsedItems?: ParsedReceiptItem[];
};

export function parseMiscReceipt(input: ParseMiscReceiptInput): ReceiptParserResult {
  if (input.modelParsedItems?.length) {
    const parsedItems = shouldUseMerchantAsSingleLineLabel(input)
      ? relabelSingleServiceReceiptItem(input.modelParsedItems, buildMiscReceiptLabel(input))
      : input.modelParsedItems;

    return {
      merchant: "misc",
      item_numbers: parsedItems.map((item) => item.product_number).filter(Boolean),
      parsed_items: parsedItems,
      debug: {
        parser_status: "openai-line-items",
        parser_message: "Used OpenAI-extracted misc receipt line items.",
        parsed_item_count: parsedItems.length,
      },
    };
  }

  const totalAmount = detectMiscReceiptTotal(input.lines);
  const receiptLabel = buildMiscReceiptLabel(input);
  const hasDetectedTotal = Number.isFinite(totalAmount) && (totalAmount as number) > 0;

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

function shouldUseMerchantAsSingleLineLabel(input: ParseMiscReceiptInput): boolean {
  if (input.modelParsedItems?.length !== 1) return false;

  const merchantText = `${input.merchantName || ""} ${input.transactionName || ""}`.toLowerCase();
  return /\b(patreon|shopify|google workspace|cricut|gfl|minutekey|minute\s*key)\b/.test(merchantText);
}

function relabelSingleServiceReceiptItem(items: ParsedReceiptItem[], merchantLabel: string): ParsedReceiptItem[] {
  const item = items[0];
  const originalLabel = String(item?.receipt_label || "").trim();
  const cleanMerchantLabel = String(merchantLabel || "").trim();

  if (!item || !cleanMerchantLabel) return items;

  return [{
    ...item,
    receipt_label: cleanMerchantLabel,
    raw_lines: [
      ...(Array.isArray(item.raw_lines) ? item.raw_lines : []),
      originalLabel && originalLabel !== cleanMerchantLabel ? `Receipt description: ${originalLabel}` : "",
    ].filter(Boolean),
  }];
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
  const matches = [...String(line || "").matchAll(/(?:USD\s*)?\$?\s*(\d[\d,]*\.\d{2})(?:\s*USD)?/gi)];
  const match = matches[matches.length - 1];
  if (!match?.[1]) return null;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
