import {
  dedupeItemNumbers,
  extractItemNumbersFromLineItems,
  extractLineItemNumber,
  isLikelyLineItem,
} from "./line-item-parser.ts";
import { assertEquals } from "jsr:@std/assert";

Deno.test("extractLineItemNumber captures 9-12 digit value not strictly at column 1", () => {
  const line = "  0000744575 24CT SHARPI 11.98 T.";
  assertEquals(extractLineItemNumber(line), "0000744575");
  assertEquals(isLikelyLineItem(line), true);
});

Deno.test("extractItemNumbersFromLineItems keeps only likely line-item numbers and normalizes", () => {
  const lines = [
    "  0000744575 24CT SHARPI 11.98 T.",
    "subtotal 11.98",
    "000001234567 SOME OTHER ITEM",
  ];

  assertEquals(extractItemNumbersFromLineItems(lines), ["744575", "1234567"]);
});

Deno.test("dedupeItemNumbers strips leading zeros and deduplicates", () => {
  assertEquals(dedupeItemNumbers(["0000744575", "744575", "0000744575"]), ["744575"]);
});
