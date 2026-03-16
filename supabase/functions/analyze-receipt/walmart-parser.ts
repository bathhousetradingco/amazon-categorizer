import { dedupeItemNumbers } from "./line-item-parser.ts";
import type { ParsedReceiptItem, ReceiptParserResult } from "./parser-types.ts";

const WALMART_IDENTIFIER_PATTERN = /(?:^|\D)(\d{8,14})(?=\D|$)/g;
const TRAILING_PRICE_PATTERN = /(\d+\.\d{2})\s*$/;

export function parseWalmartReceipt(lines: string[], candidateItemNumbers: string[]): ReceiptParserResult {
  const inlineCandidates = new Set<string>();
  const parsedItems: ParsedReceiptItem[] = [];

  lines.forEach((rawLine, index) => {
    const line = String(rawLine || "").trim();
    if (!line) return;

    const priceMatch = line.match(TRAILING_PRICE_PATTERN);
    const linePrice = priceMatch ? Number.parseFloat(priceMatch[1]) : Number.NaN;
    let bestIdentifier = "";

    for (const match of line.matchAll(WALMART_IDENTIFIER_PATTERN)) {
      const digits = String(match[1] || "").replace(/^0+/, "");
      if (digits.length >= 4) {
        inlineCandidates.add(digits);
        if (!bestIdentifier || digits.length > bestIdentifier.length) {
          bestIdentifier = digits;
        }
      }
    }

    if (!bestIdentifier || !Number.isFinite(linePrice)) return;

    const receiptLabel = extractReceiptLabel(line, bestIdentifier, linePrice);
    if (!receiptLabel) return;

    parsedItems.push({
      product_number: bestIdentifier,
      identifier_type: "upc",
      quantity: 1,
      unit_price: linePrice,
      total_price: linePrice,
      receipt_label: receiptLabel,
      line_index: index,
      raw_lines: [line],
      parser_confidence: "medium",
    });
  });

  return {
    merchant: "walmart",
    item_numbers: dedupeItemNumbers([...candidateItemNumbers, ...inlineCandidates]),
    parsed_items: parsedItems,
    debug: {
      parser_status: parsedItems.length ? "implemented" : "partial",
      parser_message: parsedItems.length
        ? "Walmart one-line parser extracted identifier and price pairs."
        : "Walmart parser found identifier candidates but no confident one-line items.",
      candidate_identifier_count: inlineCandidates.size,
      parsed_item_count: parsedItems.length,
    },
  };
}

function extractReceiptLabel(line: string, identifier: string, price: number): string {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedPrice = price.toFixed(2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return line
    .replace(new RegExp(`(?:^|\\D)0*${escapedIdentifier}(?=\\D|$)`), " ")
    .replace(new RegExp(`\\s+${escapedPrice}\\s*$`), " ")
    .replace(/\bF\b/g, " ")
    .replace(/\bN\b/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .trim();
}
