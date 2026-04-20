import { extractLineItemNumber, normalizeProductNumber } from "./line-item-parser.ts";
import type { ParsedReceiptItem } from "./parser-types.ts";

const PURCHASE_INFO_PATTERN = /^(\d+)\s+AT(?:\s+1)?\s+FOR\s+(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)\b/i;
const INST_SV_LINE_PATTERN = /^INST\s+SV\b/i;
const INST_SV_AMOUNT_PATTERN = /(\d+(?:\.\d{1,2})?)-\s*[A-Z.]*\s*$/i;
const SINGLE_LINE_PRICE_PATTERN = /^(.*?)\s+(\d+(?:\.\d{1,2})?)(?:\s+([A-Z.]+))?\s*$/i;
const PRICE_ONLY_LINE_PATTERN = /^(\d+(?:\.\d{1,2})?)(?:\s+([A-Z.]+))?\s*$/i;

export function extractSamsClubParsedItems(lines: string[], itemNumbers: string[]): ParsedReceiptItem[] {
  const parsedItems: ParsedReceiptItem[] = [];
  const anchors = new Set(itemNumbers);

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    const number = extractLineItemNumber(line);
    if (!number) continue;

    const detectedProductNumber = normalizeProductNumber(number);
    const normalizedProductNumber = normalizeKnownSamsClubItemNumber(detectedProductNumber, line);
    if (!normalizedProductNumber || (!anchors.has(detectedProductNumber) && !anchors.has(normalizedProductNumber))) continue;

    const nextLine = String(lines[i + 1] || "").trim();
    const purchaseMatch = nextLine.match(PURCHASE_INFO_PATTERN);
    if (!purchaseMatch) {
      const standaloneItem = parseStandaloneSamsClubItem({
        line,
        normalizedProductNumber,
        lineIndex: i,
        nextLine,
        nextNextLine: String(lines[i + 2] || "").trim(),
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

function normalizeKnownSamsClubItemNumber(itemNumber: string, line: string): string {
  if (itemNumber === "98006417" && /\bMM\s+25\s+SUGAR\b/i.test(String(line || ""))) {
    return "980066417";
  }

  return itemNumber;
}

function extractReceiptLabel(line: string): string {
  const text = String(line || "").trim();
  if (!text) return "";

  const withoutItemNumber = text.replace(/^.*?(?:^|\D)\d{9,12}(?=\D|$)\s*/, "");
  const withoutTrailingPrice = stripTrailingStandalonePrice(withoutItemNumber);
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
  nextNextLine?: string;
}): ParsedReceiptItem | null {
  const lineWithoutItemNumber = String(input.line || "").trim().replace(/^.*?(?:^|\D)\d{9,12}(?=\D|$)\s*/, "");
  const sameLinePrice = parseStandalonePriceSuffix(lineWithoutItemNumber);
  const splitLinePrice = sameLinePrice ? null : parsePriceOnlyLine(input.nextLine);
  const priceInfo = sameLinePrice || splitLinePrice;
  if (!priceInfo) return null;

  const unitPrice = priceInfo.price;
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
      ...(!sameLinePrice && input.nextLine ? [input.nextLine] : []),
    ].filter(Boolean),
    parser_confidence: "medium",
  };

  const savingsLine = findMatchingInstantSavingsLine(
    receiptLabel,
    sameLinePrice ? String(input.nextLine || "").trim() : String(input.nextNextLine || "").trim(),
    String(input.nextNextLine || "").trim(),
  );
  const instantSavingsAmount = parseInstantSavingsAmount(savingsLine);
  if (Number.isFinite(instantSavingsAmount)) {
    parsedItem.instant_savings_discount = instantSavingsAmount;
    parsedItem.raw_lines = [...new Set([...(parsedItem.raw_lines || []), savingsLine])];
  }

  return parsedItem;
}

function stripTrailingStandalonePrice(value: string): string {
  const priceInfo = parseStandalonePriceSuffix(value);
  return priceInfo ? priceInfo.label : value;
}

function parseStandalonePriceSuffix(value: string): { label: string; price: number } | null {
  const match = String(value || "").trim().match(SINGLE_LINE_PRICE_PATTERN);
  if (!match || !isReceiptPriceFlag(match[3])) return null;

  const label = String(match[1] || "").trim();
  const price = Number.parseFloat(match[2]);
  if (!label || !Number.isFinite(price)) return null;

  return { label, price };
}

function parsePriceOnlyLine(value: string | undefined): { price: number } | null {
  const match = String(value || "").trim().match(PRICE_ONLY_LINE_PATTERN);
  if (!match || !isReceiptPriceFlag(match[2])) return null;

  const price = Number.parseFloat(match[1]);
  if (!Number.isFinite(price)) return null;

  return { price };
}

function isReceiptPriceFlag(value: string | undefined): boolean {
  const flag = String(value || "").replace(/\./g, "").trim().toUpperCase();
  if (!flag) return true;

  return ["B", "F", "T", "Y"].includes(flag);
}

function findMatchingInstantSavingsLine(
  receiptLabel: string,
  nextLine: string,
  nextNextLine: string,
): string {
  const candidates = [nextLine, nextNextLine].filter(Boolean);
  return candidates.find((line) => {
    if (!INST_SV_LINE_PATTERN.test(line)) return false;
    return labelsOverlap(receiptLabel, extractInstantSavingsLabel(line));
  }) || "";
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
    .replace(/\s+\d+(?:\.\d{1,2})?-\s*[A-Z.]*\s*$/i, "")
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
