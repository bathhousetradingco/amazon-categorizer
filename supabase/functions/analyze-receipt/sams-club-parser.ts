import { extractLineItemNumber, normalizeProductNumber } from "./line-item-parser.ts";

const PURCHASE_INFO_PATTERN = /^(\d+)\s+AT\s+1\s+FOR\s+(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)\b/i;
const INST_SV_LINE_PATTERN = /^INST\s+SV\b/i;
const INST_SV_AMOUNT_PATTERN = /(\d+(?:\.\d{1,2})?)-\s*$/;

export type ParsedReceiptItem = {
  product_number: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  instant_savings_discount?: number;
};

export function extractSamsClubParsedItems(lines: string[], itemNumbers: string[]): ParsedReceiptItem[] {
  const parsedItems: ParsedReceiptItem[] = [];
  const anchors = new Set(itemNumbers);

  for (let i = 0; i < lines.length - 1; i++) {
    const line = String(lines[i] || "").trim();
    const number = extractLineItemNumber(line);
    if (!number) continue;

    const normalizedProductNumber = normalizeProductNumber(number);
    if (!normalizedProductNumber || !anchors.has(normalizedProductNumber)) continue;

    const nextLine = String(lines[i + 1] || "").trim();
    const purchaseMatch = nextLine.match(PURCHASE_INFO_PATTERN);
    if (!purchaseMatch) continue;

    const quantity = Number.parseInt(purchaseMatch[1], 10);
    const unitPrice = Number.parseFloat(purchaseMatch[2]);
    const totalPrice = Number.parseFloat(purchaseMatch[3]);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice) || !Number.isFinite(totalPrice)) continue;

    const parsedItem: ParsedReceiptItem = {
      product_number: normalizedProductNumber,
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
    };

    const instantSavingsLine = String(lines[i + 2] || "").trim();
    if (INST_SV_LINE_PATTERN.test(instantSavingsLine)) {
      const instantSavingsAmount = parseInstantSavingsAmount(instantSavingsLine);
      if (Number.isFinite(instantSavingsAmount)) {
        parsedItem.instant_savings_discount = instantSavingsAmount;
      }
    }

    console.log("Parsed Item:", parsedItem);
    parsedItems.push(parsedItem);
  }

  return parsedItems;
}

function parseInstantSavingsAmount(line: string): number {
  const match = String(line || "").match(INST_SV_AMOUNT_PATTERN);
  if (!match) return Number.NaN;

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
