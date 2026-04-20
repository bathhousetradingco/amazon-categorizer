import { detectReceiptMerchant } from "./merchant-detector.ts";
import { parseMiscReceipt } from "./misc-receipt-parser.ts";
import type { ParsedReceiptItem, ReceiptParserResult } from "./parser-types.ts";
import { extractSamsClubParsedItems } from "./sams-club-parser.ts";
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
    return {
      merchant,
      item_numbers: input.candidateItemNumbers,
      parsed_items: extractSamsClubParsedItems(input.lines, input.candidateItemNumbers),
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
