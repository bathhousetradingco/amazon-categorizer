import { assertEquals } from "jsr:@std/assert";
import {
  buildAmazonBusinessAuthorizeUrl,
  getAmazonBusinessEndpoint,
  normalizeAmazonBusinessMarketplaceRegion,
  normalizeAmazonBusinessRegion,
  normalizeAmazonOrderLineItem,
} from "./amazon-business.ts";

Deno.test("normalizeAmazonBusinessRegion accepts supported regions", () => {
  assertEquals(normalizeAmazonBusinessRegion("EU"), "EU");
  assertEquals(normalizeAmazonBusinessRegion("jp"), "FE");
  assertEquals(normalizeAmazonBusinessRegion("unknown"), "NA");
});

Deno.test("getAmazonBusinessEndpoint returns production and sandbox endpoints", () => {
  assertEquals(getAmazonBusinessEndpoint("NA", false), "https://na.business-api.amazon.com");
  assertEquals(getAmazonBusinessEndpoint("NA", true), "https://sandbox.na.business-api.amazon.com");
});

Deno.test("normalizeAmazonBusinessMarketplaceRegion defaults to US order region", () => {
  assertEquals(normalizeAmazonBusinessMarketplaceRegion("us"), "US");
  assertEquals(normalizeAmazonBusinessMarketplaceRegion(""), "US");
});

Deno.test("buildAmazonBusinessAuthorizeUrl adds redirect and state", () => {
  const url = buildAmazonBusinessAuthorizeUrl({
    authorizationUrl: "https://www.amazon.com/b2b/abws/oauth",
    redirectUri: "https://example.com/callback",
    state: "state-123",
  });

  assertEquals(url, "https://www.amazon.com/b2b/abws/oauth?redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-123");
});

Deno.test("buildAmazonBusinessAuthorizeUrl can build from app id", () => {
  const url = buildAmazonBusinessAuthorizeUrl({
    authorizationUrl: "",
    applicationId: "amzn1.sp.solution.example",
    marketplaceUrl: "https://www.amazon.com",
    redirectUri: "https://example.com/callback",
    state: "state-123",
  });

  assertEquals(
    url,
    "https://www.amazon.com/b2b/abws/oauth?applicationId=amzn1.sp.solution.example&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-123",
  );
});

Deno.test("normalizeAmazonOrderLineItem extracts common order line fields", () => {
  assertEquals(
    normalizeAmazonOrderLineItem({
      orderId: "111-222",
      orderLineItemId: "line-1",
      orderDate: "2026-01-02T00:00:00Z",
      orderStatus: "SHIPPED",
      purchaseOrderNumber: "PO-1",
      asin: "B000TEST",
      title: "Packaging Tape",
      sellerName: "Amazon.com",
      quantity: "2",
      itemSubtotal: { amount: "12.34", currencyCode: "USD" },
      itemTax: "1.23",
    }),
    {
      order_id: "111-222",
      line_item_key: "line-1",
      order_date: "2026-01-02T00:00:00Z",
      order_status: "SHIPPED",
      purchase_order_number: "PO-1",
      asin: "B000TEST",
      title: "Packaging Tape",
      seller_name: "Amazon.com",
      quantity: 2,
      item_subtotal: 12.34,
      item_tax: 1.23,
      item_total: 13.57,
      currency: "USD",
      raw: {
        orderId: "111-222",
        orderLineItemId: "line-1",
        orderDate: "2026-01-02T00:00:00Z",
        orderStatus: "SHIPPED",
        purchaseOrderNumber: "PO-1",
        asin: "B000TEST",
        title: "Packaging Tape",
        sellerName: "Amazon.com",
        quantity: "2",
        itemSubtotal: { amount: "12.34", currencyCode: "USD" },
        itemTax: "1.23",
      },
    },
  );
});

Deno.test("normalizeAmazonOrderLineItem extracts nested Reporting API fields", () => {
  const raw = {
    orderMetadata: {
      orderDate: { date: "2025-04-11T00:00:00Z" },
      orderId: "112-3456789-0123456",
    },
    orderLineItemId: "1",
    purchaseOrderNumber: "PO-2025-0123",
    productDetails: {
      asin: "B012345678",
      title: "Nitrile Gloves",
    },
    quantity: 3,
    charges: [
      { type: "PRINCIPAL", amount: { currencyCode: "USD", amount: 18 } },
      { type: "TAX", amount: { currencyCode: "USD", amount: 1.48 } },
      { type: "NET_TOTAL", amount: { currencyCode: "USD", amount: 19.48 } },
    ],
    seller: { name: "Amazon.com Services, Inc" },
  };

  const normalized = normalizeAmazonOrderLineItem(raw);

  assertEquals(normalized.order_id, "112-3456789-0123456");
  assertEquals(normalized.line_item_key, "1");
  assertEquals(normalized.order_date, "2025-04-11T00:00:00Z");
  assertEquals(normalized.purchase_order_number, "PO-2025-0123");
  assertEquals(normalized.asin, "B012345678");
  assertEquals(normalized.title, "Nitrile Gloves");
  assertEquals(normalized.seller_name, "Amazon.com Services, Inc");
  assertEquals(normalized.quantity, 3);
  assertEquals(normalized.item_subtotal, 18);
  assertEquals(normalized.item_tax, 1.48);
  assertEquals(normalized.item_total, 19.48);
  assertEquals(normalized.currency, "USD");
});

Deno.test("normalizeAmazonOrderLineItem builds stable fallback keys when Amazon omits line IDs", () => {
  const raw = {
    orderMetadata: {
      orderDate: { date: "2026-01-02T00:00:00Z" },
      orderId: "111-222",
    },
    productDetails: {
      asin: "B000TEST",
      title: "Packaging Tape",
    },
    quantity: 2,
    charges: [
      { type: "NET_TOTAL", amount: { currencyCode: "USD", amount: 12.34 } },
    ],
  };

  const first = normalizeAmazonOrderLineItem(raw);
  const second = normalizeAmazonOrderLineItem(raw);

  assertEquals(first.line_item_key, second.line_item_key);
  assertEquals(first.order_id, "111-222");
});
