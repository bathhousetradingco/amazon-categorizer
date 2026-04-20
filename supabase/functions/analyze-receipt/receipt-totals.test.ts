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

Deno.test("parseReceiptInstantSavingsTotal sums Sam's instant savings lines", () => {
  const rawText = [
    "INST SV 24CT SHARPI 1.00-",
    "INST SV IYC 4 CF 40 2.50- N",
    "SUB TOTAL 25.00",
  ].join("\n");

  assertEquals(parseReceiptInstantSavingsTotal(rawText), 3.5);
});
