import { assertEquals } from "jsr:@std/assert";
import { parseMiscReceipt } from "./misc-receipt-parser.ts";

Deno.test("parseMiscReceipt creates a single generic line item from receipt total", () => {
  const result = parseMiscReceipt({
    lines: [
      "Google Workspace",
      "Invoice",
      "TOTAL 18.00",
    ],
    transactionName: "GOOGLE WORKSPACE",
    merchantName: "Google Workspace",
  });

  assertEquals(result, {
    merchant: "misc",
    item_numbers: ["misc-receipt-total"],
    parsed_items: [
      {
        product_number: "misc-receipt-total",
        identifier_type: "unknown",
        quantity: 1,
        unit_price: 18,
        total_price: 18,
        receipt_label: "Google Workspace",
        line_index: 0,
        raw_lines: [
          "Google Workspace",
          "Invoice",
          "TOTAL 18.00",
        ],
        parser_confidence: "medium",
      },
    ],
    debug: {
      parser_status: "generic-fallback",
      parser_message: "Used generic misc receipt fallback item.",
      detected_total: 18,
      detected_label: "Google Workspace",
    },
  });
});
