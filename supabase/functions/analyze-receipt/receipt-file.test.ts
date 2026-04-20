import { assertEquals } from "jsr:@std/assert";
import {
  extractFilename,
  inferReceiptMimeType,
  isPdfReceipt,
  isSupportedReceiptMimeType,
  isUnsupportedReceiptMimeType,
  sniffReceiptMimeType,
  unwrapStoredDataUrl,
} from "./receipt-file.ts";

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

Deno.test("sniffReceiptMimeType identifies supported receipt bytes", () => {
  assertEquals(sniffReceiptMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(sniffReceiptMimeType(new TextEncoder().encode("%PDF-1.7")), "application/pdf");
  assertEquals(sniffReceiptMimeType(new TextEncoder().encode("GIF89a")), "image/gif");
  assertEquals(sniffReceiptMimeType(new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ])), "image/png");
  assertEquals(sniffReceiptMimeType(new TextEncoder().encode("RIFFxxxxWEBP")), "image/webp");
});

Deno.test("sniffReceiptMimeType identifies HEIC containers as unsupported", () => {
  const heicHeader = new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    0x68,
    0x65,
    0x69,
    0x63,
  ]);
  assertEquals(sniffReceiptMimeType(heicHeader), "image/heic");
  assertEquals(isUnsupportedReceiptMimeType("image/heic"), true);
});

Deno.test("unwrapStoredDataUrl decodes accidentally stored data URL text", () => {
  const dataUrl = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0))}`;
  const unwrapped = unwrapStoredDataUrl(new TextEncoder().encode(dataUrl));

  assertEquals(unwrapped?.mimeType, "image/jpeg");
  assertEquals(sniffReceiptMimeType(unwrapped?.bytes || new Uint8Array()), "image/jpeg");
  assertEquals(isSupportedReceiptMimeType(unwrapped?.mimeType || ""), true);
});
