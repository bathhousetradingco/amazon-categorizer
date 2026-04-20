import { detectReceiptMerchant } from "./merchant-detector.ts";
import { parseMiscReceipt } from "./misc-receipt-parser.ts";
import type { ParsedReceiptItem, ReceiptParserResult } from "./parser-types.ts";
import { extractSamsClubParsedItems } from "./sams-club-parser.ts";
import { dedupeItemNumbers } from "./line-item-parser.ts";
import { parseWalmartReceipt } from "./walmart-parser.ts";

type ParseReceiptInput = {
  lines: string[];
  candidateItemNumbers: string[];
  transactionName?: string | null;
  merchantName?: string | null;
  modelParsedItems?: ParsedReceiptItem[];
};

export function parseReceiptByMerchant(input: ParseReceiptInput): ReceiptParserResult {
  const merchant = detectReceiptMerchant({
    lines: input.lines,
    transactionName: input.transactionName,
    merchantName: input.merchantName,
  });

  if (merchant === "sams_club") {
    const parsedItems = extractSamsClubParsedItems(input.lines, input.candidateItemNumbers);
    return {
      merchant,
      item_numbers: dedupeItemNumbers([
        ...input.candidateItemNumbers,
        ...parsedItems.map((item) => item.product_number),
      ]),
      parsed_items: parsedItems,
      debug: {
        parser_status: "implemented",
      },
    };
  }

  if (merchant === "walmart") {
    return parseWalmartReceipt(input.lines, input.candidateItemNumbers);
  }

  return parseMiscReceipt({
    lines: input.lines,
    transactionName: input.transactionName,
    merchantName: input.merchantName,
    modelParsedItems: input.modelParsedItems,
  });
}
