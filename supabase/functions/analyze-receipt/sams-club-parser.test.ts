import { assertEquals } from "jsr:@std/assert";
import { extractSamsClubParsedItems } from "./sams-club-parser.ts";

Deno.test("extractSamsClubParsedItems parses quantity, unit, total, and instant savings", () => {
  const lines = [
    "  0000744575 24CT SHARPI 11.98 T.",
    "2 AT 1 FOR 5.99 11.98",
    "INST SV 1.00-",
  ];

  assertEquals(extractSamsClubParsedItems(lines, ["744575"]), [
    {
      product_number: "744575",
      identifier_type: "item_number",
      receipt_label: "24CT SHARPI",
      quantity: 2,
      unit_price: 5.99,
      total_price: 11.98,
      line_index: 0,
      raw_lines: [
        "0000744575 24CT SHARPI 11.98 T.",
        "2 AT 1 FOR 5.99 11.98",
        "INST SV 1.00-",
      ],
      parser_confidence: "high",
      instant_savings_discount: 1,
    },
  ]);
});

Deno.test("extractSamsClubParsedItems returns empty when purchase line format does not match", () => {
  const lines = [
    "0000744575 ITEM",
    "11.98",
  ];

  assertEquals(extractSamsClubParsedItems(lines, ["744575"]), []);
});
