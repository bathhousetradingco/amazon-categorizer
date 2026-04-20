import { assertEquals } from "jsr:@std/assert";
import {
  buildReceiptLabelMap,
  buildSamsClubSearchQuery,
  isPlausibleSamsClubMatch,
  isSamsClubSearchSource,
  isSearchableSamsClubReceiptLabel,
  chooseBestCacheRows,
  extractSamsClubCatalogSearchResolution,
  extractSamsClubDirectSearchResolution,
  extractSamsClubProductPageName,
  extractSamsClubSearchResult,
  normalizeSamsClubProductTitle,
  resolveProductNames,
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

Deno.test("resolveProductNames uses built-in verified Sam's lookup for cane sugar", async () => {
  const serviceClient = buildLookupStubClient();
  const resolved = await resolveProductNames(serviceClient, "sams_club", ["980066417"], [
    {
      product_number: "980066417",
      quantity: 1,
      unit_price: 14.98,
      total_price: 14.98,
      receipt_label: "MM 25 SUGAR",
    },
  ]);

  assertEquals(resolved["980066417"], {
    product_name: "Member's Mark Premium Cane Sugar, 25 lbs.",
    source: "verified_lookup",
    confidence: "high",
    receipt_label: "MM 25 SUGAR",
  });
});

Deno.test("resolveProductNames preserves synthetic misc receipt line identifiers", async () => {
  const serviceClient = buildLookupStubClient();
  const resolved = await resolveProductNames(serviceClient, "misc", ["model-line-1"], [
    {
      product_number: "model-line-1",
      identifier_type: "unknown",
      quantity: 1,
      unit_price: 7,
      total_price: 7,
      receipt_label: "All Recipes + One Monthly Bonus Recipe",
    },
  ]);

  assertEquals(resolved["model-line-1"], {
    product_name: "All Recipes + One Monthly Bonus Recipe",
    source: "receipt_label",
    confidence: "low",
    receipt_label: "All Recipes + One Monthly Bonus Recipe",
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

Deno.test("extractSamsClubDirectSearchResolution resolves exact item ids from Sam's hydrated search data", () => {
  const html = `
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "initialData": {
                  "items": [
                    {
                      "itemId": "990395985",
                      "productName": "Member's Mark Avocado Oil Glass Bottle, 34 fl. oz.",
                      "productUrl": "/ip/members-mark-avocado-oil-glass-bottle-34-fl-oz/17133350002"
                    }
                  ]
                }
              }
            }
          }
        </script>
      </head>
    </html>
  `;

  assertEquals(extractSamsClubDirectSearchResolution(html, "0990395985", "MM AVO OIL"), {
    product_name: "Member's Mark Avocado Oil Glass Bottle, 34 fl. oz.",
    source_url: "https://www.samsclub.com/ip/members-mark-avocado-oil-glass-bottle-34-fl-oz/17133350002",
    provider: "samsclub_direct",
  });
});

Deno.test("extractSamsClubDirectSearchResolution prefers exact item id over plausible nearby products", () => {
  const html = `
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "initialData": {
                  "items": [
                    {
                      "itemId": "111111111",
                      "productName": "Member's Mark Premium Cane Sugar Packets",
                      "productUrl": "/ip/wrong-sugar/prod111"
                    },
                    {
                      "itemId": "980066417",
                      "productName": "Member's Mark Premium Cane Sugar, 25 lbs.",
                      "productUrl": "/ip/members-mark-premium-cane-sugar-25-lbs/prod222"
                    }
                  ]
                }
              }
            }
          }
        </script>
      </head>
    </html>
  `;

  assertEquals(extractSamsClubDirectSearchResolution(html, "980066417", "MM 25 SUGAR"), {
    product_name: "Member's Mark Premium Cane Sugar, 25 lbs.",
    source_url: "https://www.samsclub.com/ip/members-mark-premium-cane-sugar-25-lbs/prod222",
    provider: "samsclub_direct",
  });
});

Deno.test("extractSamsClubDirectSearchResolution resolves direct product pages that include item number", () => {
  const html = `
    <html>
      <head>
        <link rel="canonical" href="/ip/members-mark-avocado-oil-glass-bottle-34-fl-oz/17133350002">
        <script type="application/ld+json">
          {"@type":"Product","name":"Member's Mark Avocado Oil Glass Bottle, 34 fl. oz. | Sam's Club"}
        </script>
      </head>
      <body>Item # 990395985</body>
    </html>
  `;

  assertEquals(extractSamsClubDirectSearchResolution(html, "990395985", "MM AVO OIL"), {
    product_name: "Member's Mark Avocado Oil Glass Bottle, 34 fl. oz.",
    source_url: "https://www.samsclub.com/ip/members-mark-avocado-oil-glass-bottle-34-fl-oz/17133350002",
    provider: "samsclub_direct",
  });
});

Deno.test("extractSamsClubCatalogSearchResolution prefers exact item ids from catalog API payloads", () => {
  const payload = [
    {
      itemId: "44346411",
      itemName: "Unrelated TV Stand",
      itemPageUrl: "https://www.samsclub.com/p/tv/prod1",
      variantItems: [
        {
          variantItemId: "990008301",
          variantItemName: "Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz.",
        },
      ],
    },
  ];

  assertEquals(extractSamsClubCatalogSearchResolution(payload, "990008301", "FG 40.3OZ B"), {
    product_name: "Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz.",
    source_url: "https://www.samsclub.com/p/tv/prod1",
    provider: "sams_ads_catalog",
  });
});

Deno.test("extractSamsClubCatalogSearchResolution rejects non-exact unrelated catalog names", () => {
  const payload = [{ itemId: "111111111", itemName: "Member's Mark Women's Favorite Soft Full-Zip Jacket" }];
  assertEquals(extractSamsClubCatalogSearchResolution(payload, "222222222", "MM PURE OO"), null);
});

Deno.test("extractSamsClubProductPageName reads product JSON-LD before title fallback", () => {
  const html = `
    <html>
      <head>
        <title>Fallback Title | Sam's Club</title>
        <script type="application/ld+json">
          {"@type":"Product","name":"Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz. | Sam's Club"}
        </script>
      </head>
    </html>
  `;

  assertEquals(
    extractSamsClubProductPageName(html),
    "Folgers Dark Roast Ground Coffee, Black Silk, 40.3 oz.",
  );
});

Deno.test("normalizeSamsClubProductTitle removes Sam's title suffixes", () => {
  assertEquals(
    normalizeSamsClubProductTitle("Sharpie Permanent Markers, 24 Count | Sam's Club"),
    "Sharpie Permanent Markers, 24 Count",
  );
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

function buildLookupStubClient() {
  return {
    from(table: string) {
      return {
        select() {
          return {
            in() {
              if (table === "product_lookup_cache") {
                return Promise.resolve({ data: [], error: null });
              }

              return {
                in() {
                  if (table === "product_lookup") {
                    return Promise.resolve({ data: [], error: null });
                  }
                  if (table === "product_lookup_cache") {
                    return Promise.resolve({ data: [], error: null });
                  }
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}
