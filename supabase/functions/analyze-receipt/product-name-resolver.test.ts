import { assertEquals } from "jsr:@std/assert";
import {
  buildReceiptLabelMap,
  buildSamsClubSearchQuery,
  isPlausibleSamsClubMatch,
  isSamsClubSearchSource,
  isSearchableSamsClubReceiptLabel,
  chooseBestCacheRows,
  extractSamsClubSearchResult,
} from "./product-name-resolver.ts";

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

Deno.test("buildSamsClubSearchQuery expands abbreviated Sam's receipt labels", () => {
  assertEquals(
    buildSamsClubSearchQuery("990008301", "FG 40.3OZ B"),
    "site:samsclub.com 990008301 Folgers 40.3OZ Black Silk",
  );
});

Deno.test("buildSamsClubSearchQuery expands Sam's shorthand for coffee filters", () => {
  assertEquals(
    buildSamsClubSearchQuery("990012260", "IYC 4 CF 40"),
    'site:samsclub.com 990012260 If You Care #4 Coffee Filters 400 ct',
  );
});

Deno.test("buildSamsClubSearchQuery expands Sam's shorthand for Sharpie packs", () => {
  assertEquals(
    buildSamsClubSearchQuery("744575", "24CT SHARPI"),
    "site:samsclub.com 744575 24 Count Sharpie Permanent Markers",
  );
});

Deno.test("extractSamsClubSearchResult parses a DuckDuckGo result title and url", () => {
  const html = `
    <div class="results">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.samsclub.com%2Fp%2Ffolgers-dark-roast-ground-coffee-black-silk-40-3-oz%2Fprod123">
        Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz. | Sam's Club
      </a>
    </div>
  `;

  assertEquals(extractSamsClubSearchResult(html), {
    product_name: "Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz.",
    source_url: "https://www.samsclub.com/p/folgers-dark-roast-ground-coffee-black-silk-40-3-oz/prod123",
    provider: "duckduckgo_samsclub",
  });
});

Deno.test("isSearchableSamsClubReceiptLabel rejects labels that are too generic for lookup", () => {
  assertEquals(isSearchableSamsClubReceiptLabel("9401"), false);
  assertEquals(isSearchableSamsClubReceiptLabel("24CT"), false);
  assertEquals(isSearchableSamsClubReceiptLabel("TAX"), false);
});

Deno.test("isSearchableSamsClubReceiptLabel accepts distinctive Sam's receipt shorthand", () => {
  assertEquals(isSearchableSamsClubReceiptLabel("FG 40.3OZ B"), true);
  assertEquals(isSearchableSamsClubReceiptLabel("IYC 4 CF 40"), true);
  assertEquals(isSearchableSamsClubReceiptLabel("24CT SHARPI"), true);
});

Deno.test("isSamsClubSearchSource requires Sam's Club source evidence", () => {
  assertEquals(isSamsClubSearchSource("Sam's Club", "Folgers Coffee", ""), true);
  assertEquals(isSamsClubSearchSource("", "Folgers Coffee | Sam's Club", ""), true);
  assertEquals(isSamsClubSearchSource("Amazon", "Folgers Coffee", "https://www.amazon.com/item"), false);
});

Deno.test("isPlausibleSamsClubMatch accepts meaningful Sam's title expansions", () => {
  assertEquals(
    isPlausibleSamsClubMatch("FG 40.3OZ B", "Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz."),
    true,
  );
});

Deno.test("isPlausibleSamsClubMatch rejects unrelated search hits", () => {
  assertEquals(
    isPlausibleSamsClubMatch("MM 25 SUGAR", "Meow Mix, Original Choice Flavor Adult Dry Cat Food"),
    false,
  );
});

Deno.test("isPlausibleSamsClubMatch rejects brand-only overlap", () => {
  assertEquals(
    isPlausibleSamsClubMatch("MM PURE OO", "Member's Mark Women's Favorite Soft Full-Zip Jacket"),
    false,
  );
});
