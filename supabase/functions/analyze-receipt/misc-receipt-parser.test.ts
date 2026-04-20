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

Deno.test("parseMiscReceipt prefers OpenAI-extracted line items for misc receipts", () => {
  const result = parseMiscReceipt({
    lines: [
      "Soap Supplier",
      "TOTAL 29.99",
    ],
    transactionName: "SOAP SUPPLIER",
    merchantName: "Soap Supplier",
    modelParsedItems: [
      {
        product_number: "model-line-1",
        identifier_type: "unknown",
        quantity: 2,
        unit_price: 8.5,
        total_price: 17,
        receipt_label: "Goat Milk Soap Base",
        parser_confidence: "low",
      },
      {
        product_number: "model-line-2",
        identifier_type: "unknown",
        quantity: 1,
        unit_price: 12.99,
        total_price: 12.99,
        receipt_label: "Essential Oil",
        parser_confidence: "low",
      },
    ],
  });

  assertEquals(result, {
    merchant: "misc",
    item_numbers: ["model-line-1", "model-line-2"],
    parsed_items: [
      {
        product_number: "model-line-1",
        identifier_type: "unknown",
        quantity: 2,
        unit_price: 8.5,
        total_price: 17,
        receipt_label: "Goat Milk Soap Base",
        parser_confidence: "low",
      },
      {
        product_number: "model-line-2",
        identifier_type: "unknown",
        quantity: 1,
        unit_price: 12.99,
        total_price: 12.99,
        receipt_label: "Essential Oil",
        parser_confidence: "low",
      },
    ],
    debug: {
      parser_status: "openai-line-items",
      parser_message: "Used OpenAI-extracted misc receipt line items.",
      parsed_item_count: 2,
    },
  });
});

Deno.test("parseMiscReceipt creates fallback item from USD currency total", () => {
  const result = parseMiscReceipt({
    lines: [
      "PATREON",
      "RECEIPT",
      "CREATOR DESCRIPTION PRICE TAX TOTAL",
      "Cory O'Briant All Recipes + One Monthly Bonus Recipe $7.00 (0%) $0.00 $7.00",
      "Total USD $7.00 USD $0.00 USD $7.00",
    ],
    transactionName: "PATREON",
    merchantName: "Patreon",
  });

  assertEquals(result.item_numbers, ["misc-receipt-total"]);
  assertEquals(result.parsed_items[0]?.receipt_label, "Patreon");
  assertEquals(result.parsed_items[0]?.total_price, 7);
  assertEquals(result.debug?.detected_total, 7);
});
