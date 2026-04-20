import { fetchWithTimeout } from "../_shared/fetch.ts";
import type { ParsedReceiptItem, ReceiptMerchant } from "./parser-types.ts";

export type ResolvedProduct = {
  product_name: string;
  source: "verified_lookup" | "lookup_cache" | "receipt_label" | "sams_club_search";
  confidence: "high" | "medium" | "low";
  receipt_label?: string;
  source_url?: string | null;
  brand?: string | null;
  category?: string | null;
};

type VerifiedLookupRow = {
  merchant?: string | null;
  item_number?: string | null;
  product_name?: string | null;
};

type CacheLookupRow = {
  sku?: string | null;
  normalized_sku?: string | null;
  clean_name?: string | null;
  source_url?: string | null;
  brand?: string | null;
  category?: string | null;
  last_checked_at?: string | null;
};

type SearchResolution = {
  product_name: string;
  source_url?: string | null;
  provider?: "sams_ads_catalog" | "serpapi_samsclub" | "duckduckgo_samsclub";
};

type SamsAdsCatalogConfig = {
  apiUrl: string;
  advertiserId: string;
  accessToken: string;
  consumerId?: string;
  keyVersion?: string;
  authSignature?: string;
};

export async function resolveProductNames(
  serviceClient: any,
  merchant: ReceiptMerchant,
  itemNumbers: string[],
  parsedItems: ParsedReceiptItem[],
): Promise<Record<string, ResolvedProduct>> {
  const normalizedItemNumbers = [...new Set(itemNumbers.map(normalizeLookupKey).filter(Boolean))];
  if (!normalizedItemNumbers.length) return {};

  const receiptLabels = buildReceiptLabelMap(parsedItems);
  const [verifiedRows, cacheRows] = await Promise.all([
    loadVerifiedLookups(serviceClient, merchant, normalizedItemNumbers),
    loadCacheLookups(serviceClient, merchant, normalizedItemNumbers),
  ]);

  const verifiedByItemNumber = new Map(
    verifiedRows
      .map((row) => ({
        item_number: normalizeLookupKey(row?.item_number),
        product_name: cleanLookupLabel(row?.product_name),
      }))
      .filter((row) => row.item_number && row.product_name)
      .map((row) => [row.item_number, row.product_name]),
  );

  const cacheByItemNumber = chooseBestCacheRows(cacheRows);
  const unresolvedForSearch: Array<{ itemNumber: string; receiptLabel?: string }> = [];
  const resolved: Record<string, ResolvedProduct> = {};

  for (const itemNumber of normalizedItemNumbers) {
    const receiptLabel = receiptLabels[itemNumber];
    const verifiedName = verifiedByItemNumber.get(itemNumber);

    if (verifiedName) {
      resolved[itemNumber] = {
        product_name: verifiedName,
        source: "verified_lookup",
        confidence: "high",
        ...(receiptLabel ? { receipt_label: receiptLabel } : {}),
      };
      continue;
    }

    const cacheRow = cacheByItemNumber.get(itemNumber);
    if (cacheRow?.clean_name) {
      resolved[itemNumber] = {
        product_name: cacheRow.clean_name,
        source: "lookup_cache",
        confidence: "medium",
        ...(receiptLabel ? { receipt_label: receiptLabel } : {}),
        ...(cacheRow.source_url ? { source_url: cacheRow.source_url } : {}),
        ...(cacheRow.brand ? { brand: cacheRow.brand } : {}),
        ...(cacheRow.category ? { category: cacheRow.category } : {}),
      };
      continue;
    }

    if (receiptLabel) {
      resolved[itemNumber] = {
        product_name: receiptLabel,
        source: "receipt_label",
        confidence: "low",
        receipt_label: receiptLabel,
      };
      if (merchant === "sams_club") {
        unresolvedForSearch.push({ itemNumber, receiptLabel });
      }
      continue;
    }

  }

  if (merchant === "sams_club" && unresolvedForSearch.length) {
    const searchResolutions = await enrichSamsClubNames(serviceClient, unresolvedForSearch);

    for (const [itemNumber, resolution] of searchResolutions.entries()) {
      const receiptLabel = receiptLabels[itemNumber];
      resolved[itemNumber] = {
        product_name: resolution.product_name,
        source: "sams_club_search",
        confidence: "medium",
        ...(receiptLabel ? { receipt_label: receiptLabel } : {}),
        ...(resolution.source_url ? { source_url: resolution.source_url } : {}),
      };
    }
  }

  return resolved;
}

export function buildReceiptLabelMap(parsedItems: ParsedReceiptItem[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const item of parsedItems) {
    const itemNumber = normalizeLookupKey(item?.product_number);
    const receiptLabel = cleanLookupLabel(item?.receipt_label);
    if (!itemNumber || !receiptLabel || labels[itemNumber]) continue;
    labels[itemNumber] = receiptLabel;
  }

  return labels;
}

export function chooseBestCacheRows(rows: CacheLookupRow[]): Map<string, Required<Pick<CacheLookupRow, "clean_name" | "source_url" | "brand" | "category">>> {
  const result = new Map<string, Required<Pick<CacheLookupRow, "clean_name" | "source_url" | "brand" | "category">>>();

  const sortedRows = [...rows].sort((left, right) => {
    const leftTime = Date.parse(String(left?.last_checked_at || "")) || 0;
    const rightTime = Date.parse(String(right?.last_checked_at || "")) || 0;
    return rightTime - leftTime;
  });

  for (const row of sortedRows) {
    const itemNumber = normalizeLookupKey(row?.normalized_sku || row?.sku);
    const cleanName = cleanLookupLabel(row?.clean_name);
    if (!itemNumber || !cleanName || result.has(itemNumber)) continue;

    result.set(itemNumber, {
      clean_name: cleanName,
      source_url: String(row?.source_url || "") || null,
      brand: String(row?.brand || "") || null,
      category: String(row?.category || "") || null,
    });
  }

  return result;
}

export function buildSamsClubSearchQuery(itemNumber: string, receiptLabel?: string): string {
  const parts = [
    "site:samsclub.com",
    itemNumber,
    expandSamsReceiptLabel(receiptLabel),
  ].filter(Boolean);

  return parts.join(" ");
}

export function extractSamsClubSearchResult(html: string): SearchResolution | null {
  const text = String(html || "");
  if (!text) return null;

  const matches = text.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of matches) {
    const sourceUrl = normalizeSearchResultUrl(decodeHtml(match[1] || ""));
    if (!/samsclub\.com/i.test(sourceUrl)) continue;

    const rawTitle = stripHtml(decodeHtml(match[2] || ""));
    const cleanedTitle = rawTitle
      .replace(/\s*[|:-]\s*Sam'?s Club.*$/i, "")
      .replace(/\s*[|:-]\s*Buy Now.*$/i, "")
      .trim();

    if (!cleanedTitle) continue;

    return {
      product_name: cleanedTitle,
      source_url: sourceUrl,
      provider: "duckduckgo_samsclub",
    };
  }

  return null;
}

export function extractSamsClubCatalogSearchResolution(
  payload: unknown,
  itemNumber: string,
  receiptLabel?: string,
): SearchResolution | null {
  const targetItemNumber = normalizeLookupKey(itemNumber);
  const rawEntries = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.items)
    ? (payload as any).items
    : Array.isArray((payload as any)?.data)
    ? (payload as any).data
    : [];

  const candidates: Array<SearchResolution & { itemId?: string }> = [];

  for (const entry of rawEntries) {
    candidates.push(...buildSamsCatalogCandidates(entry));
  }

  for (const candidate of candidates) {
    if (!candidate.product_name) continue;
    const candidateItemNumber = normalizeLookupKey(candidate.itemId);
    const isExactItemId = Boolean(candidateItemNumber && candidateItemNumber === targetItemNumber);
    if (!isExactItemId && receiptLabel && !isPlausibleSamsClubMatch(receiptLabel, candidate.product_name)) continue;

    return {
      product_name: candidate.product_name,
      source_url: candidate.source_url || null,
      provider: "sams_ads_catalog",
    };
  }

  return null;
}

function buildSamsCatalogCandidates(entry: any): Array<SearchResolution & { itemId?: string }> {
  const candidates: Array<SearchResolution & { itemId?: string }> = [];

  const addCandidate = (itemId: unknown, name: unknown, url: unknown) => {
    const productName = cleanLookupLabel(name);
    if (!productName) return;

    candidates.push({
      itemId: String(itemId || ""),
      product_name: productName,
      source_url: String(url || "") || null,
      provider: "sams_ads_catalog",
    });
  };

  addCandidate(entry?.itemId, entry?.itemName, entry?.itemPageUrl);

  for (const variant of Array.isArray(entry?.variantItems) ? entry.variantItems : []) {
    addCandidate(
      variant?.variantItemId,
      variant?.variantItemName,
      variant?.variantItemPageUrl || entry?.itemPageUrl,
    );
  }

  return candidates;
}

export function extractSamsClubProductPageName(html: string): string {
  const text = String(html || "");
  if (!text) return "";

  const jsonLdName = extractJsonLdProductNames(text)
    .map(normalizeSamsClubProductTitle)
    .find(Boolean);
  if (jsonLdName) return jsonLdName;

  const metaTitle = extractMetaContent(text, "property", "og:title") ||
    extractMetaContent(text, "name", "twitter:title");
  const normalizedMetaTitle = normalizeSamsClubProductTitle(metaTitle);
  if (normalizedMetaTitle) return normalizedMetaTitle;

  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeSamsClubProductTitle(stripHtml(decodeHtml(titleMatch?.[1] || "")));
}

function extractJsonLdProductNames(html: string): string[] {
  const names: string[] = [];
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const script of scripts) {
    const rawJson = decodeHtml(stripHtml(script[1] || ""));
    const parsed = tryParseJson(rawJson);
    collectJsonLdProductNames(parsed, names);
  }

  return names;
}

function collectJsonLdProductNames(value: unknown, names: string[]) {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((entry) => collectJsonLdProductNames(entry, names));
    return;
  }

  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const graph = record["@graph"];
  if (graph) collectJsonLdProductNames(graph, names);

  const typeValue = record["@type"];
  const types = Array.isArray(typeValue) ? typeValue : [typeValue];
  const isProduct = types.some((type) => String(type || "").toLowerCase() === "product");
  if (isProduct && record.name) {
    names.push(cleanLookupLabel(record.name));
  }
}

function extractMetaContent(html: string, attrName: string, attrValue: string): string {
  const escapedValue = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta\\b(?=[^>]*\\b${attrName}=["']${escapedValue}["'])(?=[^>]*\\bcontent=["']([^"']+)["'])[^>]*>`, "i");
  const match = html.match(pattern);
  return decodeHtml(match?.[1] || "");
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeSamsClubProductTitle(value: unknown): string {
  return cleanLookupLabel(value)
    .replace(/\s*[|:-]\s*Sam'?s Club.*$/i, "")
    .replace(/\s*[|:-]\s*Buy Now.*$/i, "")
    .replace(/\s+\|\s+SamsClub\.com.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSearchableSamsClubReceiptLabel(receiptLabel: string | undefined): boolean {
  const cleaned = cleanLookupLabel(receiptLabel);
  if (!cleaned) return false;

  const originalText = normalizeComparisonText(cleaned);
  const originalLetters = originalText.replace(/[^a-z]/g, "");
  if (originalLetters.length < 2) return false;

  const expandedText = normalizeComparisonText(expandSamsReceiptLabel(cleaned));
  const searchableTokens = expandedText
    .split(" ")
    .filter((token) => /[a-z]/.test(token))
    .filter((token) => token.length >= 3)
    .filter((token) => !SAM_SEARCH_NOISE_TOKENS.has(token))
    .filter((token) => !SAM_SEARCH_GENERIC_TOKENS.has(token));

  return searchableTokens.length > 0;
}

export function isPlausibleSamsClubMatch(
  receiptLabel: string | undefined,
  candidateName: string | undefined,
): boolean {
  const expandedReceipt = normalizeComparisonText(expandSamsReceiptLabel(receiptLabel));
  const normalizedCandidate = normalizeComparisonText(candidateName);

  if (!expandedReceipt || !normalizedCandidate) return false;

  const receiptTokens = expandedReceipt.split(" ").filter((token) => token.length >= 3);
  if (!receiptTokens.length) return false;

  const overlap = receiptTokens.filter((token) => normalizedCandidate.includes(token));
  const overlapRatio = overlap.length / receiptTokens.length;
  const distinctiveReceiptTokens = receiptTokens.filter((token) => !SAM_SEARCH_NOISE_TOKENS.has(token));
  const distinctiveOverlap = distinctiveReceiptTokens.filter((token) => normalizedCandidate.includes(token));

  if (!distinctiveOverlap.length) return false;

  return overlapRatio >= 0.75 ||
    distinctiveOverlap.length >= 2 ||
    (distinctiveReceiptTokens.length === 1 && distinctiveOverlap.length === 1);
}

async function loadVerifiedLookups(
  serviceClient: any,
  merchant: ReceiptMerchant,
  itemNumbers: string[],
): Promise<VerifiedLookupRow[]> {
  const merchantScopes = merchant === "misc" ? ["any"] : [merchant, "any"];
  const { data, error } = await serviceClient
    .from("product_lookup")
    .select("merchant, item_number, product_name")
    .in("merchant", merchantScopes)
    .in("normalized_item_number", itemNumbers);

  if (error) {
    console.error("Failed to load verified product lookup rows", error);
    return [];
  }

  return Array.isArray(data) ? data : [];
}

async function loadCacheLookups(
  serviceClient: any,
  merchant: ReceiptMerchant,
  itemNumbers: string[],
): Promise<CacheLookupRow[]> {
  if (merchant !== "sams_club") return [];

  const { data, error } = await serviceClient
    .from("product_lookup_cache")
    .select("sku, normalized_sku, clean_name, source_url, brand, category, last_checked_at")
    .in("normalized_sku", itemNumbers);

  if (error) {
    console.error("Failed to load product lookup cache rows", error);
    return [];
  }

  return Array.isArray(data) ? data : [];
}

async function enrichSamsClubNames(
  serviceClient: any,
  items: Array<{ itemNumber: string; receiptLabel?: string }>,
): Promise<Map<string, SearchResolution>> {
  const results = new Map<string, SearchResolution>();

  for (const item of items) {
    try {
      const resolution = await searchSamsClubByItemNumber(item.itemNumber, item.receiptLabel);
      if (!resolution?.product_name) continue;
      if (item.receiptLabel && !isPlausibleSamsClubMatch(item.receiptLabel, resolution.product_name)) continue;

      results.set(item.itemNumber, resolution);
      await upsertLookupCache(serviceClient, item.itemNumber, resolution);
    } catch (error) {
      console.warn("Sam's Club search enrichment failed", { itemNumber: item.itemNumber, error });
    }
  }

  return results;
}

async function searchSamsClubByItemNumber(
  itemNumber: string,
  receiptLabel?: string,
): Promise<SearchResolution | null> {
  if (!isSearchableSamsClubReceiptLabel(receiptLabel)) return null;

  const adsCatalogResolution = await searchSamsClubByAdvertisingCatalog(itemNumber, receiptLabel);
  if (adsCatalogResolution?.product_name) {
    return refineSamsClubResolutionWithProductPage(adsCatalogResolution, receiptLabel);
  }

  const serpApiResolution = await searchSamsClubBySerpApi(itemNumber, receiptLabel);
  if (serpApiResolution?.product_name) {
    return refineSamsClubResolutionWithProductPage(serpApiResolution, receiptLabel);
  }

  const queries = buildSamsClubSearchQueries(itemNumber, receiptLabel);

  for (const query of queries) {
    const response = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BathhouseCategorizer/1.0)",
      },
    }, 10000);

    if (!response.ok) continue;
    const html = await response.text();
    const resolution = extractSamsClubSearchResult(html);
    if (resolution?.product_name) return refineSamsClubResolutionWithProductPage(resolution, receiptLabel);
  }

  return null;
}

async function searchSamsClubByAdvertisingCatalog(
  itemNumber: string,
  receiptLabel?: string,
): Promise<SearchResolution | null> {
  const config = getSamsAdsCatalogConfig();
  if (!config) return null;

  const itemIdResolution = await invokeSamsAdsCatalogSearch(config, { searchItemIds: [itemNumber] }, itemNumber, receiptLabel);
  if (itemIdResolution?.product_name) return itemIdResolution;

  const searchText = expandSamsReceiptLabel(receiptLabel);
  if (!searchText) return null;

  return invokeSamsAdsCatalogSearch(config, { searchText }, itemNumber, receiptLabel);
}

async function invokeSamsAdsCatalogSearch(
  config: SamsAdsCatalogConfig,
  searchInput: { searchItemIds?: string[]; searchText?: string },
  itemNumber: string,
  receiptLabel?: string,
): Promise<SearchResolution | null> {
  try {
    const response = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: buildSamsAdsCatalogHeaders(config),
      body: JSON.stringify({
        advertiserId: Number(config.advertiserId) || config.advertiserId,
        ...searchInput,
      }),
    }, 10000);

    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return extractSamsClubCatalogSearchResolution(payload, itemNumber, receiptLabel);
  } catch (error) {
    console.warn("Sam's Club advertising catalog lookup failed", { itemNumber, error });
    return null;
  }
}

function buildSamsAdsCatalogHeaders(config: SamsAdsCatalogConfig): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.accessToken}`,
    "Content-Type": "application/json",
    "wm_qos.correlation_id": crypto.randomUUID(),
    "wm_consumer.intimestamp": Date.now().toString(),
  };

  if (config.consumerId) headers["wm_consumer.id"] = config.consumerId;
  if (config.keyVersion) headers["wm_sec.key_version"] = config.keyVersion;
  if (config.authSignature) headers["wm_sec.auth_signature"] = config.authSignature;

  return headers;
}

async function refineSamsClubResolutionWithProductPage(
  resolution: SearchResolution,
  receiptLabel?: string,
): Promise<SearchResolution> {
  const sourceUrl = String(resolution.source_url || "");
  if (!/samsclub\.com/i.test(sourceUrl)) return resolution;

  try {
    const response = await fetchWithTimeout(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BathhouseCategorizer/1.0)",
      },
    }, 10000);

    if (!response.ok) return resolution;
    const productName = extractSamsClubProductPageName(await response.text());
    if (!productName) return resolution;
    if (receiptLabel && !isPlausibleSamsClubMatch(receiptLabel, productName)) return resolution;

    return {
      ...resolution,
      product_name: productName,
    };
  } catch {
    return resolution;
  }
}

async function searchSamsClubBySerpApi(
  itemNumber: string,
  receiptLabel?: string,
): Promise<SearchResolution | null> {
  const serpApiKey = getSerpApiKey();
  if (!serpApiKey) return null;

  try {
    for (const query of buildSamsClubSerpApiQueries(itemNumber, receiptLabel)) {
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine", "google_shopping");
      url.searchParams.set("q", query);
      url.searchParams.set("num", "5");
      url.searchParams.set("api_key", serpApiKey);

      const response = await fetchWithTimeout(url, {}, 10000);
      if (!response.ok) continue;

      const payload = await response.json().catch(() => null);
      const shoppingResults = Array.isArray(payload?.shopping_results) ? payload.shopping_results : [];
      const organicResults = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
      const entries = [...shoppingResults, ...organicResults];

      for (const entry of entries) {
        const title = cleanLookupLabel(entry?.title);
        const sourceUrl = normalizeSearchResultUrl(String(entry?.link || entry?.product_link || ""));
        const sourceName = cleanLookupLabel([
          entry?.source,
          entry?.store,
          entry?.merchant,
          entry?.seller,
          entry?.domain,
          entry?.displayed_link,
        ].filter(Boolean).join(" "));
        if (!title) continue;
        if (!isSamsClubSearchSource(sourceName, title, sourceUrl)) continue;
        if (receiptLabel && !isPlausibleSamsClubMatch(receiptLabel, title)) continue;

        return {
          product_name: title,
          source_url: sourceUrl || null,
          provider: "serpapi_samsclub",
        };
      }
    }

    return null;
  } catch (error) {
    console.warn("SerpApi Sam's Club lookup failed", { itemNumber, error });
    return null;
  }
}

function buildSamsClubSerpApiQueries(itemNumber: string, receiptLabel?: string): string[] {
  const expandedLabel = expandSamsReceiptLabel(receiptLabel);

  return [
    expandedLabel ? `${itemNumber} ${expandedLabel} sams club` : "",
    expandedLabel ? `"${itemNumber}" "${expandedLabel}" "sam's club"` : "",
    `${itemNumber} sams club`,
  ].filter(Boolean);
}

function buildSamsClubSearchQueries(itemNumber: string, receiptLabel?: string): string[] {
  const expandedLabel = expandSamsReceiptLabel(receiptLabel);

  return [
    `site:samsclub.com ${itemNumber}`,
    buildSamsClubSearchQuery(itemNumber, receiptLabel),
    expandedLabel ? `site:samsclub.com "${expandedLabel}" "${itemNumber}"` : "",
    expandedLabel ? `site:samsclub.com ${expandedLabel}` : "",
  ].filter(Boolean);
}

async function upsertLookupCache(
  serviceClient: any,
  itemNumber: string,
  resolution: SearchResolution,
) {
  const cleanName = cleanLookupLabel(resolution.product_name);
  if (!cleanName) return;

  const { error } = await serviceClient
    .from("product_lookup_cache")
    .upsert({
      sku: itemNumber,
      clean_name: cleanName,
      source: resolution.provider || "samsclub_search",
      source_url: resolution.source_url || null,
      last_checked_at: new Date().toISOString(),
    }, { onConflict: "sku" });

  if (error) {
    console.warn("Failed to upsert product lookup cache", { itemNumber, error });
  }
}

function normalizeLookupKey(value: unknown): string {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

function cleanLookupLabel(value: unknown): string {
  return decodeHtml(String(value || "").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value: string): string {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSearchResultUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const normalizedRaw = raw.startsWith("//") ? `https:${raw}` : raw;
    const url = new URL(normalizedRaw, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return url.toString();
  } catch {
    return raw;
  }
}

export function isSamsClubSearchSource(sourceName: string, title: string, sourceUrl: string): boolean {
  const combinedSource = cleanLookupLabel(sourceName);
  const combinedTitle = cleanLookupLabel(title);

  return /samsclub\.com/i.test(sourceUrl) ||
    /samsclub\.com/i.test(combinedSource) ||
    /\bsam'?s\s+club\b/i.test(combinedSource) ||
    /\bsam'?s\s+club\b/i.test(combinedTitle);
}

function expandSamsReceiptLabel(value: unknown): string {
  return cleanLookupLabel(value)
    .replace(/\bIYC\b/gi, "If You Care")
    .replace(/\bFG\b/gi, "Folgers")
    .replace(/\bMM\b/gi, "Member's Mark")
    .replace(/\bCHARMIN\b/gi, "Charmin")
    .replace(/\bOO\b/gi, "Olive Oil")
    .replace(/\bSHARPI\b/gi, "Sharpie Permanent Markers")
    .replace(/\b24CT\b/gi, "24 Count")
    .replace(/\b4\s+CF\s+40\b/gi, "#4 Coffee Filters 400 ct")
    .replace(/\bCF\b/gi, "Coffee Filters")
    .replace(/\bCARB\s+MIN\s+WT\b/gi, "Carbonated Mineral Water")
    .replace(/\bCARB\b/gi, "Carbonated")
    .replace(/\bMIN\b/gi, "Mineral")
    .replace(/\bWT\b/gi, "Water")
    .replace(/\bB\b$/i, "Black Silk")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparisonText(value: unknown): string {
  return cleanLookupLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSerpApiKey(): string {
  try {
    return Deno.env.get("SERPAPI_KEY") || Deno.env.get("SERPAPI_API_KEY") || "";
  } catch {
    return "";
  }
}

function getSamsAdsCatalogConfig(): SamsAdsCatalogConfig | null {
  try {
    const advertiserId = Deno.env.get("SAMS_ADS_ADVERTISER_ID") || "";
    const accessToken = Deno.env.get("SAMS_ADS_ACCESS_TOKEN") || "";
    if (!advertiserId || !accessToken) return null;

    return {
      apiUrl: Deno.env.get("SAMS_ADS_ITEM_SEARCH_URL") ||
        "https://developer.api.us.walmart.com/api-proxy/service/sp/api-sams/v1/api/v1/itemSearch",
      advertiserId,
      accessToken,
      consumerId: Deno.env.get("SAMS_ADS_CONSUMER_ID") || undefined,
      keyVersion: Deno.env.get("SAMS_ADS_KEY_VERSION") || undefined,
      authSignature: Deno.env.get("SAMS_ADS_AUTH_SIGNATURE") || undefined,
    };
  } catch {
    return null;
  }
}

const SAM_SEARCH_NOISE_TOKENS = new Set([
  "club",
  "mark",
  "member",
  "members",
  "sams",
]);

const SAM_SEARCH_GENERIC_TOKENS = new Set([
  "count",
  "each",
  "inst",
  "pack",
  "pk",
  "sale",
  "subtotal",
  "tax",
  "total",
]);
