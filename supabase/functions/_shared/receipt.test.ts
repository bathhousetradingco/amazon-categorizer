import { parseReceiptItems } from "./receipt.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("parseReceiptItems consolidates duplicate promo lines with same code", () => {
  const items = parseReceiptItems([
    { name: "SODA 6 AT 1 FOR 8.88", amount: 53.28, code: "123456" },
    { name: "SODA 6 AT 1 FOR 8.88", amount: 53.28, code: "123456" },
  ]);

  assert(items.length === 1, `expected 1 consolidated item, got ${items.length}`);
  assert(items[0].quantity === 12, `expected quantity 12, got ${items[0].quantity}`);
  assert(items[0].total === 106.56, `expected total 106.56, got ${items[0].total}`);
  assert(items[0].qualityFlags.includes("consolidated_duplicate_promo"), "expected consolidated flag");
});

Deno.test("parseReceiptItems does not consolidate non-promo duplicates", () => {
  const items = parseReceiptItems([
    { name: "BANANAS", amount: 2.5, code: "11111" },
    { name: "BANANAS", amount: 2.5, code: "11111" },
  ]);

  assert(items.length === 2, `expected 2 items, got ${items.length}`);
});
