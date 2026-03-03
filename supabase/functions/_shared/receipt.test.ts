import { mergeExtractedReceiptItems, parseReceiptItems } from "./receipt.ts";

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

Deno.test("mergeExtractedReceiptItems preserves tabscanner-only product code when names differ", () => {
  const merged = mergeExtractedReceiptItems(
    [{ name: "CHKN BRST BNLS SKNLS", amount: "24.99", code: null }],
    [{ name: "123456789012 CHKN BRST", amount: "24.99", code: "123456789012" }],
  ) as Array<{ code: string | null }>;

  assert(merged.length === 1, `expected 1 item, got ${merged.length}`);
  assert(merged[0].code === "123456789012", `expected merged code from tabscanner, got ${merged[0].code}`);
});

Deno.test("parseReceiptItems extracts sku from embedded leading product number", () => {
  const items = parseReceiptItems([
    { name: "123456789012 CHKN BRST BNLS SKNLS", amount: 24.99, code: null },
  ], { store: "sams_club" });

  assert(items.length === 1, `expected 1 parsed item, got ${items.length}`);
  assert(items[0].sku === "123456789012", `expected sku 123456789012, got ${items[0].sku}`);
});

Deno.test("parseReceiptItems parses 2 AT 1 FOR promotion quantity and totals", () => {
  const items = parseReceiptItems([
    { name: "WATER 2 AT 1 FOR 5.00", amount: 15.0, code: "99887766" },
  ]);

  assert(items.length === 1, `expected 1 item, got ${items.length}`);
  assert(items[0].quantity === 2, `expected quantity 2, got ${items[0].quantity}`);
  assert(items[0].unitPrice === 5, `expected unit price 5, got ${items[0].unitPrice}`);
  assert(items[0].total === 15, `expected total 15, got ${items[0].total}`);
  assert(items[0].totalMismatch === true, "expected mismatch when explicit total differs from promo quantity");
});
