import { assertEquals } from "jsr:@std/assert";
import {
  completeReceiptTotals,
  parseReceiptInstantSavingsTotal,
  parseReceiptTotals,
} from "./receipt-totals.ts";

Deno.test("parseReceiptTotals extracts subtotal, summed tax, and receipt total", () => {
  const rawText = [
    "SUB TOTAL       42.50",
    "TAX 1            2.12",
    "TAX 2            0.38",
    "TOTAL           45.00",
  ].join("\n");

  assertEquals(parseReceiptTotals(rawText), {
    subtotal: 42.5,
    tax: 2.5,
    receiptTotal: 45,
  });
});

Deno.test("parseReceiptTotals handles invoice totals with USD and dollar signs", () => {
  const rawText = [
    "Cory O'Briant All Recipes + One Monthly Bonus Recipe $7.00 (0%) $0.00 $7.00",
    "Total USD $7.00 USD $0.00 USD $7.00",
  ].join("\n");

  assertEquals(parseReceiptTotals(rawText), {
    subtotal: null,
    tax: null,
    receiptTotal: 7,
  });
});

Deno.test("parseReceiptTotals keeps tax total separate from receipt total", () => {
  const rawText = [
    "Subtotal $9.99",
    "Tax Total $0.00",
    "Order Total $9.99",
  ].join("\n");

  assertEquals(parseReceiptTotals(rawText), {
    subtotal: 9.99,
    tax: 0,
    receiptTotal: 9.99,
  });
});

Deno.test("parseReceiptTotals does not treat tax transaction fees as sales tax", () => {
  const rawText = [
    "Shipping (18 items) $156.55 USD",
    "Tax transaction fees (172 items) $43.93 USD",
    "Subtotal $200.48 USD",
    "Total $200.48 USD",
  ].join("\n");

  assertEquals(parseReceiptTotals(rawText), {
    tax: null,
    subtotal: 200.48,
    receiptTotal: 200.48,
  });
});

Deno.test("parseReceiptTotals handles subtotal tax total table rows", () => {
  const rawText = [
    "Subtotal Tax Total",
    "USD $9.99 USD $0.00 USD $9.99",
  ].join("\n");

  assertEquals(parseReceiptTotals(rawText), {
    subtotal: 9.99,
    tax: 0,
    receiptTotal: 9.99,
  });
});

Deno.test("completeReceiptTotals infers missing subtotal from parsed line items", () => {
  assertEquals(
    completeReceiptTotals(
      { subtotal: null, tax: 0, receiptTotal: 1 },
      [{ total_price: 1 }],
    ),
    { subtotal: 1, tax: 0, receiptTotal: 1 },
  );
});

Deno.test("completeReceiptTotals repairs zero subtotal when total and parsed lines are positive", () => {
  assertEquals(
    completeReceiptTotals(
      { subtotal: 0, tax: 0, receiptTotal: 9.99 },
      [{ total_price: 9.99 }],
    ),
    { subtotal: 9.99, tax: 0, receiptTotal: 9.99 },
  );
});

Deno.test("completeReceiptTotals infers missing tax from subtotal and receipt total", () => {
  assertEquals(
    completeReceiptTotals(
      { subtotal: 2941.95, tax: null, receiptTotal: 3280.85 },
      [],
    ),
    { subtotal: 2941.95, tax: 338.9, receiptTotal: 3280.85 },
  );
});

Deno.test("completeReceiptTotals infers missing tax from parsed items when subtotal is missing", () => {
  assertEquals(
    completeReceiptTotals(
      { subtotal: null, tax: null, receiptTotal: 3280.85 },
      [{ total_price: 2845 }, { total_price: 96.95 }],
    ),
    { subtotal: 2941.95, tax: null, receiptTotal: 3280.85 },
  );
});

Deno.test("completeReceiptTotals does not infer unrealistic missing tax gaps", () => {
  assertEquals(
    completeReceiptTotals(
      { subtotal: 100, tax: null, receiptTotal: 180 },
      [],
    ),
    { subtotal: 100, tax: null, receiptTotal: 180 },
  );
});

Deno.test("parseReceiptTotals handles one-decimal total tax rows", () => {
  const rawText = [
    "Subtotal $3,051.95",
    "Grand Total (Ex.Tax) $3,051.95",
    "Total Tax $228.9",
    "Grand Total (Inc.Tax) $3,280.85",
  ].join("\n");

  assertEquals(parseReceiptTotals(rawText), {
    subtotal: 3051.95,
    tax: 228.9,
    receiptTotal: 3280.85,
  });
});

Deno.test("parseReceiptInstantSavingsTotal sums Sam's instant savings lines", () => {
  const rawText = [
    "INST SV 24CT SHARPI 1.00-",
    "INST SV IYC 4 CF 40 2.50- N",
    "SUB TOTAL 25.00",
  ].join("\n");

  assertEquals(parseReceiptInstantSavingsTotal(rawText), 3.5);
});
