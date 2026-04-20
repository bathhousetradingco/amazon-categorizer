# Receipt Line Item Name Resolution

This app should treat receipt line-item names as a confidence-ranked pipeline, not a single search call.

## Current Resolution Order

1. `product_lookup` verified names
   - Highest confidence.
   - Created when a user confirms or edits a product name in the detected receipt item flow.
   - Scoped by merchant plus item number, with `any` as fallback scope.

2. `product_lookup_cache`
   - Medium confidence.
   - Stores successful search/API resolutions so repeated receipt scans do not call external services again.

3. Sam's Club Advertising Catalog API
   - Used only when credentials are configured.
   - Environment variables:
     - `SAMS_ADS_ADVERTISER_ID`
     - `SAMS_ADS_ACCESS_TOKEN`
     - optional `SAMS_ADS_ITEM_SEARCH_URL`
     - optional `SAMS_ADS_CONSUMER_ID`
     - optional `SAMS_ADS_KEY_VERSION`
     - optional `SAMS_ADS_AUTH_SIGNATURE`
   - This is the most accurate non-manual path when available because it can search item ids in a Sam's catalog directly.
   - The official API is an advertising-partner API, not a public lookup endpoint. It may require signed Walmart/Sam's request headers beyond a bearer token.

4. SerpApi Google Shopping search
   - Used when `SERPAPI_KEY` or `SERPAPI_API_KEY` is configured.
   - Results are accepted only when source evidence points to Sam's Club and the product title plausibly overlaps the receipt label.

5. DuckDuckGo HTML search
   - No key required.
   - Results are accepted only from `samsclub.com` URLs.

6. Sam's Club product page refinement
   - When any accepted result has a `samsclub.com` product page URL, the function fetches that page and prefers the product name from JSON-LD, then social meta title, then the page title.
   - The refined page name still has to plausibly match the receipt label.

7. Receipt label fallback
   - Lowest confidence.
   - Kept visible so the user can manually confirm or correct it.

## Operational Notes

- The frontend still requires user confirmation before assigning categories for product names that are not from `verified_lookup`.
- For accounting/export accuracy, the verified lookup table is the long-term source of truth.
- Generic labels such as numeric-only strings, `24CT`, `TAX`, and other non-distinctive receipt text should not trigger paid search calls.
- Sam's instant savings should stay attached to the parsed line item so split amounts reflect net cost.

## Better Accuracy Options

- Best practical path: obtain Sam's Advertising Catalog API credentials and configure the `SAMS_ADS_*` environment variables.
- Best internal path: keep building verified `product_lookup` rows from user confirmations and seed common repeat purchases through migrations.
- Useful fallback: keep SerpApi enabled, but use it as a candidate finder only. Do not trust results unless the source and receipt-label overlap pass validation.
- Avoid using broad web search alone for accounting line items. It can return plausible but wrong products when receipt labels are abbreviated.

## References

- Sam's Advertising Partners Catalog Item Search: https://developer.samsclub.com/API/catalog-item-search/
- SerpApi Google Shopping Results API: https://serpapi.com/shopping-results
- Walmart Marketplace Item Search API, useful for Walmart receipts when UPC/GTIN is available: https://developer.walmart.com/us-marketplace/lang-es/docs/item-search-for-the-walmart-catalog
