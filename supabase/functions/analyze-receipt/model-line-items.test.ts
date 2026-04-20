import { assertEquals } from "jsr:@std/assert";
import { normalizeModelReceiptItems } from "./model-line-items.ts";

Deno.test("normalizeModelReceiptItems converts OpenAI misc receipt lines into parsed items", () => {
  assertEquals(
    normalizeModelReceiptItems([
      {
        description: "Goat Milk Soap Base",
        quantity: 2,
        unit_price: 8.5,
        total_price: 17,
        raw_text: "Goat Milk Soap Base 2 x 8.50 17.00",
      },
      {
        description: "Tax",
        total_price: 1.4,
      },
      {
        description: "Essential Oil",
        quantity: 1,
        total: 12.99,
      },
    ]),
    [
      {
        product_number: "model-line-1",
        identifier_type: "unknown",
        quantity: 2,
        unit_price: 8.5,
        total_price: 17,
        receipt_label: "Goat Milk Soap Base",
        raw_lines: ["Goat Milk Soap Base 2 x 8.50 17.00"],
        parser_confidence: "low",
      },
      {
        product_number: "model-line-3",
        identifier_type: "unknown",
        quantity: 1,
        unit_price: 12.99,
        total_price: 12.99,
        receipt_label: "Essential Oil",
        raw_lines: ["Essential Oil"],
        parser_confidence: "low",
      },
    ],
  );
});

Deno.test("normalizeModelReceiptItems preserves usable model item numbers", () => {
  assertEquals(
    normalizeModelReceiptItems([
      {
        item_number: "000123456789",
        description: "Packaging Tape",
        quantity: 3,
        unit_price: 4,
        total_price: 12,
      },
    ]),
    [
      {
        product_number: "123456789",
        identifier_type: "item_number",
        quantity: 3,
        unit_price: 4,
        total_price: 12,
        receipt_label: "Packaging Tape",
        raw_lines: ["Packaging Tape"],
        parser_confidence: "low",
      },
    ],
  );
});

Deno.test("normalizeModelReceiptItems accepts currency-formatted model prices", () => {
  assertEquals(
    normalizeModelReceiptItems([
      {
        description: "All Recipes + One Monthly Bonus Recipe",
        quantity: "1",
        unit_price: "$7.00",
        total_price: "USD $7.00",
        raw_text: "All Recipes + One Monthly Bonus Recipe $7.00 (0%) $0.00 $7.00",
      },
    ]),
    [
      {
        product_number: "model-line-1",
        identifier_type: "unknown",
        quantity: 1,
        unit_price: 7,
        total_price: 7,
        receipt_label: "All Recipes + One Monthly Bonus Recipe",
        raw_lines: ["All Recipes + One Monthly Bonus Recipe $7.00 (0%) $0.00 $7.00"],
        parser_confidence: "low",
      },
    ],
  );
});
