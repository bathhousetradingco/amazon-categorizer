import { assertEquals } from "jsr:@std/assert";
import { parseWalmartReceipt } from "./walmart-parser.ts";

Deno.test("parseWalmartReceipt extracts one-line item details when identifier and price share a line", () => {
  const result = parseWalmartReceipt([
    "WALMART",
    "GV PAPER TOWELS 000123456789 8.97",
    "BANANAS 000000044017 1.62",
  ], []);

  assertEquals(result.item_numbers, ["123456789", "44017"]);
  assertEquals(result.parsed_items, [
    {
      product_number: "123456789",
      identifier_type: "upc",
      quantity: 1,
      unit_price: 8.97,
      total_price: 8.97,
      receipt_label: "GV PAPER TOWELS",
      line_index: 1,
      raw_lines: ["GV PAPER TOWELS 000123456789 8.97"],
      parser_confidence: "medium",
    },
    {
      product_number: "44017",
      identifier_type: "upc",
      quantity: 1,
      unit_price: 1.62,
      total_price: 1.62,
      receipt_label: "BANANAS",
      line_index: 2,
      raw_lines: ["BANANAS 000000044017 1.62"],
      parser_confidence: "medium",
    },
  ]);
});

Deno.test("parseWalmartReceipt handles Walmart OCR style lines with optional F flag", () => {
  const result = parseWalmartReceipt([
    "WAL*MART",
    "ENVELOPES    505478180437      11.83",
    "PG CARD      075959891273       8.87",
    "BURGER BUN   068113107536 F     4.97",
    "PG 6 ENVEL   505478180448       4.56",
  ], []);

  assertEquals(result.item_numbers, ["505478180437", "75959891273", "68113107536", "505478180448"]);
  assertEquals(result.parsed_items, [
    {
      product_number: "505478180437",
      identifier_type: "upc",
      quantity: 1,
      unit_price: 11.83,
      total_price: 11.83,
      receipt_label: "ENVELOPES",
      line_index: 1,
      raw_lines: ["ENVELOPES    505478180437      11.83"],
      parser_confidence: "medium",
    },
    {
      product_number: "75959891273",
      identifier_type: "upc",
      quantity: 1,
      unit_price: 8.87,
      total_price: 8.87,
      receipt_label: "PG CARD",
      line_index: 2,
      raw_lines: ["PG CARD      075959891273       8.87"],
      parser_confidence: "medium",
    },
    {
      product_number: "68113107536",
      identifier_type: "upc",
      quantity: 1,
      unit_price: 4.97,
      total_price: 4.97,
      receipt_label: "BURGER BUN",
      line_index: 3,
      raw_lines: ["BURGER BUN   068113107536 F     4.97"],
      parser_confidence: "medium",
    },
    {
      product_number: "505478180448",
      identifier_type: "upc",
      quantity: 1,
      unit_price: 4.56,
      total_price: 4.56,
      receipt_label: "PG 6 ENVEL",
      line_index: 4,
      raw_lines: ["PG 6 ENVEL   505478180448       4.56"],
      parser_confidence: "medium",
    },
  ]);
});

Deno.test("parseWalmartReceipt preserves repeated items from long grocery receipts", () => {
  const result = parseWalmartReceipt([
    "GOAT MILK    007290400012 F     3.98",
    "GOAT MILK    007290400012 F     3.98",
    "GVCORNSTARC  007874200283 F     1.92",
  ], []);

  assertEquals(result.item_numbers, ["7290400012", "7874200283"]);
  assertEquals(result.parsed_items.length, 3);
  assertEquals(result.parsed_items[0]?.receipt_label, "GOAT MILK");
  assertEquals(result.parsed_items[1]?.receipt_label, "GOAT MILK");
  assertEquals(result.parsed_items[2]?.receipt_label, "GVCORNSTARC");
});
