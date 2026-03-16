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

    if (merchant === "sams_club") {
      unresolvedForSearch.push({ itemNumber });
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
    };
  }

  return null;
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

  return overlapRatio >= 0.5 || overlap.length >= 2;
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
    if (resolution?.product_name) return resolution;
  }

  return null;
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
      source: "duckduckgo_samsclub",
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

function expandSamsReceiptLabel(value: unknown): string {
  return cleanLookupLabel(value)
    .replace(/\bFG\b/gi, "Folgers")
    .replace(/\bMM\b/gi, "Member's Mark")
    .replace(/\bOO\b/gi, "Olive Oil")
    .replace(/\bCARB\b/gi, "Carbona")
    .replace(/\bMIN\b/gi, "Mineral")
    .replace(/\bWT\b/gi, "Water")
    .replace(/\bB\b$/i, "Black Silk")
    .trim();
}

function normalizeComparisonText(value: unknown): string {
  return cleanLookupLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
