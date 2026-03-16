import { assertEquals } from "jsr:@std/assert";
import { detectReceiptMerchant } from "./merchant-detector.ts";

Deno.test("detectReceiptMerchant identifies Sam's Club receipts from receipt text", () => {
  assertEquals(
    detectReceiptMerchant({
      lines: ["SAM'S CLUB #8209", "INST SV 1.00-"],
    }),
    "sams_club",
  );
});

Deno.test("detectReceiptMerchant identifies Walmart receipts from merchant context", () => {
  assertEquals(
    detectReceiptMerchant({
      lines: ["Thank you for shopping with us"],
      merchantName: "Walmart",
    }),
    "walmart",
  );
});
