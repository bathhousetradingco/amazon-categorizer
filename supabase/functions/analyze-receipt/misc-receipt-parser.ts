import type { ReceiptParserResult } from "./parser-types.ts";

export function parseMiscReceipt(): ReceiptParserResult {
  return {
    merchant: "misc",
    item_numbers: [],
    parsed_items: [],
    debug: {
      parser_status: "stub",
      parser_message: "No merchant-specific parser matched this receipt.",
    },
  };
}
