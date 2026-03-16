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

Deno.test("extractSamsClubParsedItems falls back to single-line Sam's item rows with trailing price", () => {
  const lines = [
    "0990293734 CHARMIN 31.48 T",
    "0980022771 HD SHIPPING 21.47 T",
  ];

  assertEquals(extractSamsClubParsedItems(lines, ["990293734", "980022771"]), [
    {
      product_number: "990293734",
      identifier_type: "item_number",
      receipt_label: "CHARMIN",
      quantity: 1,
      unit_price: 31.48,
      total_price: 31.48,
      line_index: 0,
      raw_lines: [
        "0990293734 CHARMIN 31.48 T",
      ],
      parser_confidence: "medium",
    },
    {
      product_number: "980022771",
      identifier_type: "item_number",
      receipt_label: "HD SHIPPING",
      quantity: 1,
      unit_price: 21.47,
      total_price: 21.47,
      line_index: 1,
      raw_lines: [
        "0980022771 HD SHIPPING 21.47 T",
      ],
      parser_confidence: "medium",
    },
  ]);
});

Deno.test("extractSamsClubParsedItems keeps instant savings on single-line fallback items", () => {
  const lines = [
    "0000744575 24CT SHARPI 11.98 T",
    "0990012260 IYC 4 CF 40 8.48 T",
    "INST SV 24CT SHARPI 2.50-",
  ];

  assertEquals(extractSamsClubParsedItems(lines, ["744575"]), [
    {
      product_number: "744575",
      identifier_type: "item_number",
      receipt_label: "24CT SHARPI",
      quantity: 1,
      unit_price: 11.98,
      total_price: 11.98,
      line_index: 0,
      raw_lines: [
        "0000744575 24CT SHARPI 11.98 T",
        "INST SV 24CT SHARPI 2.50-",
      ],
      parser_confidence: "medium",
      instant_savings_discount: 2.5,
    },
  ]);
});
