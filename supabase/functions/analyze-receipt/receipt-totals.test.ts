import { assertEquals } from "jsr:@std/assert";
import { parseReceiptInstantSavingsTotal, parseReceiptTotals } from "./receipt-totals.ts";

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

Deno.test("parseReceiptInstantSavingsTotal sums Sam's instant savings lines", () => {
  const rawText = [
    "INST SV 24CT SHARPI 1.00-",
    "INST SV IYC 4 CF 40 2.50- N",
    "SUB TOTAL 25.00",
  ].join("\n");

  assertEquals(parseReceiptInstantSavingsTotal(rawText), 3.5);
});
