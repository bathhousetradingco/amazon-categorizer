import { assertEquals } from "jsr:@std/assert";
import { findAmazonPlaidSupersedeMatches } from "./amazon-business-supersede.ts";

Deno.test("findAmazonPlaidSupersedeMatches matches Amazon order totals to later Plaid charges", () => {
  const matches = findAmazonPlaidSupersedeMatches(
    [{
      id: "txn-1",
      date: "2026-01-06",
      amount: 80.53,
      name: "AMAZON MKT* EP6CK1NW3",
      merchant_name: "Amazon",
    }],
    [
      { order_id: "order-1", order_date: "2025-12-31T00:00:00Z", amount: 15.99 },
      { order_id: "order-1", order_date: "2025-12-31T00:00:00Z", amount: 19.99 },
      { order_id: "order-1", order_date: "2025-12-31T00:00:00Z", amount: 25.99 },
      { order_id: "order-1", order_date: "2025-12-31T00:00:00Z", amount: 17.99 },
    ],
  );

  assertEquals(matches, [{
    transaction_id: "txn-1",
    order_id: "order-1",
    plaid_amount: 80.53,
    order_amount: 79.96,
    difference: 0.57,
    date_delta_days: 6,
  }]);
});

Deno.test("findAmazonPlaidSupersedeMatches ignores non-Amazon Plaid charges", () => {
  const matches = findAmazonPlaidSupersedeMatches(
    [{ id: "txn-1", date: "2026-01-06", amount: 80.53, name: "Target", merchant_name: "Target" }],
    [{ order_id: "order-1", order_date: "2026-01-05", amount: 80.53 }],
  );

  assertEquals(matches, []);
});

Deno.test("findAmazonPlaidSupersedeMatches skips orders outside the amount tolerance", () => {
  const matches = findAmazonPlaidSupersedeMatches(
    [{ id: "txn-1", date: "2026-01-06", amount: 80.53, name: "Amazon", merchant_name: "Amazon" }],
    [{ order_id: "order-1", order_date: "2026-01-05", amount: 60 }],
  );

  assertEquals(matches, []);
});

Deno.test("findAmazonPlaidSupersedeMatches does not reuse one Amazon order for multiple Plaid charges", () => {
  const matches = findAmazonPlaidSupersedeMatches(
    [
      { id: "txn-1", date: "2026-01-06", amount: 80.53, name: "Amazon", merchant_name: "Amazon" },
      { id: "txn-2", date: "2026-01-06", amount: 80.53, name: "Amazon", merchant_name: "Amazon" },
    ],
    [{ order_id: "order-1", order_date: "2026-01-05", amount: 80.53 }],
  );

  assertEquals(matches.length, 1);
  assertEquals(matches[0].transaction_id, "txn-1");
});
