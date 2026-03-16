import { assertEquals } from "jsr:@std/assert";
import { buildReceiptLabelMap, chooseBestCacheRows } from "./product-name-resolver.ts";

Deno.test("buildReceiptLabelMap keeps the first non-empty receipt label per item number", () => {
  assertEquals(
    buildReceiptLabelMap([
      {
        product_number: "744575",
        quantity: 2,
        unit_price: 5.99,
        total_price: 11.98,
        receipt_label: "24CT SHARPI",
      },
      {
        product_number: "744575",
        quantity: 1,
        unit_price: 5.99,
        total_price: 5.99,
        receipt_label: "IGNORED DUPLICATE",
      },
      {
        product_number: "1234567",
        quantity: 1,
        unit_price: 3.49,
        total_price: 3.49,
      },
    ]),
    { "744575": "24CT SHARPI" },
  );
});

Deno.test("chooseBestCacheRows prefers the freshest clean cache row per normalized sku", () => {
  const rows = chooseBestCacheRows([
    {
      sku: "0000744575",
      normalized_sku: "744575",
      clean_name: "Older Sharpie 24 Count",
      source_url: "https://example.com/older",
      brand: "Sharpie",
      category: "Office",
      last_checked_at: "2026-03-01T00:00:00Z",
    },
    {
      sku: "744575",
      normalized_sku: "744575",
      clean_name: "Sharpie Permanent Markers 24 Count",
      source_url: "https://example.com/newer",
      brand: "Sharpie",
      category: "Office",
      last_checked_at: "2026-03-05T00:00:00Z",
    },
  ]);

  assertEquals(rows.get("744575"), {
    clean_name: "Sharpie Permanent Markers 24 Count",
    source_url: "https://example.com/newer",
    brand: "Sharpie",
    category: "Office",
  });
});
