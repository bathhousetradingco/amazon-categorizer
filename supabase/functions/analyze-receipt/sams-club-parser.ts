import { extractLineItemNumber, normalizeProductNumber } from "./line-item-parser.ts";
import type { ParsedReceiptItem } from "./parser-types.ts";

const PURCHASE_INFO_PATTERN = /^(\d+)\s+AT\s+1\s+FOR\s+(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)\b/i;
const INST_SV_LINE_PATTERN = /^INST\s+SV\b/i;
const INST_SV_AMOUNT_PATTERN = /(\d+(?:\.\d{1,2})?)-\s*$/;
const SINGLE_LINE_PRICE_PATTERN = /^(.*?)(\d+(?:\.\d{1,2})?)\s+([A-Z.]+)\s*$/i;

export function extractSamsClubParsedItems(lines: string[], itemNumbers: string[]): ParsedReceiptItem[] {
  const parsedItems: ParsedReceiptItem[] = [];
  const anchors = new Set(itemNumbers);

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    const number = extractLineItemNumber(line);
    if (!number) continue;

    const normalizedProductNumber = normalizeProductNumber(number);
    if (!normalizedProductNumber || !anchors.has(normalizedProductNumber)) continue;

    const nextLine = String(lines[i + 1] || "").trim();
    const purchaseMatch = nextLine.match(PURCHASE_INFO_PATTERN);
    if (!purchaseMatch) {
      const standaloneItem = parseStandaloneSamsClubItem({
        line,
        normalizedProductNumber,
        lineIndex: i,
        nextLine,
      });
      if (standaloneItem) parsedItems.push(standaloneItem);
      continue;
    }

    const quantity = Number.parseInt(purchaseMatch[1], 10);
    const unitPrice = Number.parseFloat(purchaseMatch[2]);
    const totalPrice = Number.parseFloat(purchaseMatch[3]);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice) || !Number.isFinite(totalPrice)) continue;

    const parsedItem: ParsedReceiptItem = {
      product_number: normalizedProductNumber,
      identifier_type: "item_number",
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      receipt_label: extractReceiptLabel(line),
      line_index: i,
      raw_lines: [line, nextLine, String(lines[i + 2] || "").trim()].filter(Boolean),
      parser_confidence: "high",
    };

    const instantSavingsLine = String(lines[i + 2] || "").trim();
    if (INST_SV_LINE_PATTERN.test(instantSavingsLine)) {
      const instantSavingsAmount = parseInstantSavingsAmount(instantSavingsLine);
      if (Number.isFinite(instantSavingsAmount)) {
        parsedItem.instant_savings_discount = instantSavingsAmount;
      }
    }

    parsedItems.push(parsedItem);
  }

  applyLabeledInstantSavings(parsedItems, lines);
  return parsedItems;
}

function parseInstantSavingsAmount(line: string): number {
  const match = String(line || "").match(INST_SV_AMOUNT_PATTERN);
  if (!match) return Number.NaN;

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function extractReceiptLabel(line: string): string {
  const text = String(line || "").trim();
  if (!text) return "";

  const withoutItemNumber = text.replace(/^.*?(?:^|\D)\d{9,12}(?=\D|$)\s*/, "");
  const withoutTrailingPrice = withoutItemNumber.replace(/\s+\d+(?:\.\d{1,2})\s*[A-Z.]*\s*$/i, "");
  const cleaned = withoutTrailingPrice
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .trim();

  return cleaned;
}

function parseStandaloneSamsClubItem(input: {
  line: string;
  normalizedProductNumber: string;
  lineIndex: number;
  nextLine?: string;
}): ParsedReceiptItem | null {
  const lineWithoutItemNumber = String(input.line || "").trim().replace(/^.*?(?:^|\D)\d{9,12}(?=\D|$)\s*/, "");
  const priceMatch = lineWithoutItemNumber.match(SINGLE_LINE_PRICE_PATTERN);
  if (!priceMatch) return null;

  const unitPrice = Number.parseFloat(priceMatch[2]);
  if (!Number.isFinite(unitPrice)) return null;

  const receiptLabel = extractReceiptLabel(input.line);
  if (!receiptLabel) return null;

  const parsedItem: ParsedReceiptItem = {
    product_number: input.normalizedProductNumber,
    identifier_type: "item_number",
    quantity: 1,
    unit_price: unitPrice,
    total_price: unitPrice,
    receipt_label: receiptLabel,
    line_index: input.lineIndex,
    raw_lines: [
      input.line,
      ...(INST_SV_LINE_PATTERN.test(String(input.nextLine || "").trim()) ? [String(input.nextLine || "").trim()] : []),
    ].filter(Boolean),
    parser_confidence: "medium",
  };

  return parsedItem;
}

function applyLabeledInstantSavings(parsedItems: ParsedReceiptItem[], lines: string[]) {
  for (let index = 0; index < lines.length; index++) {
    const line = String(lines[index] || "").trim();
    if (!INST_SV_LINE_PATTERN.test(line)) continue;

    const amount = parseInstantSavingsAmount(line);
    if (!Number.isFinite(amount)) continue;

    const savingsLabel = extractInstantSavingsLabel(line);
    if (!savingsLabel) continue;

    const matchedItem = [...parsedItems]
      .reverse()
      .find((item) => {
        const itemIndex = Number(item.line_index ?? -1);
        if (!Number.isFinite(itemIndex) || itemIndex >= index) return false;
        return labelsOverlap(item.receipt_label, savingsLabel);
      });

    if (!matchedItem || Number.isFinite(matchedItem.instant_savings_discount)) continue;
    matchedItem.instant_savings_discount = amount;
    matchedItem.raw_lines = [...new Set([...(matchedItem.raw_lines || []), line])];
  }
}

function extractInstantSavingsLabel(line: string): string {
  return String(line || "")
    .replace(/^INST\s+SV\s*/i, "")
    .replace(/\s+\d+(?:\.\d{1,2})?-\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function labelsOverlap(left: string | undefined, right: string | undefined): boolean {
  const leftTokens = tokenizeLabel(left);
  const rightTokens = tokenizeLabel(right);
  if (!leftTokens.length || !rightTokens.length) return false;

  return leftTokens.some((token) => rightTokens.includes(token));
}

function tokenizeLabel(value: string | undefined): string[] {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}
