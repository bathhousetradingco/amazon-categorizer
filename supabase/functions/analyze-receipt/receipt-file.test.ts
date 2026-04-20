import { assertEquals } from "jsr:@std/assert";
import { extractFilename, inferReceiptMimeType, isPdfReceipt } from "./receipt-file.ts";

Deno.test("inferReceiptMimeType trusts supported content type headers", () => {
  assertEquals(inferReceiptMimeType("receipt.bin", "image/png; charset=binary"), "image/png");
});

Deno.test("inferReceiptMimeType falls back to path extension", () => {
  assertEquals(inferReceiptMimeType("uploads/receipt.jpeg", "application/octet-stream"), "image/jpeg");
  assertEquals(inferReceiptMimeType("uploads/receipt.pdf", ""), "application/pdf");
});

Deno.test("isPdfReceipt checks inferred MIME type", () => {
  assertEquals(isPdfReceipt("uploads/receipt.jpg", "application/pdf"), true);
  assertEquals(isPdfReceipt("uploads/receipt.pdf"), true);
  assertEquals(isPdfReceipt("uploads/receipt.jpg"), false);
});

Deno.test("extractFilename returns the final path component", () => {
  assertEquals(extractFilename("user/uploads/receipt.pdf"), "receipt.pdf");
});
