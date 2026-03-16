import type { ParsedReceiptItem, ReceiptMerchant } from "./parser-types.ts";

export type ResolvedProduct = {
  product_name: string;
  source: "verified_lookup" | "lookup_cache" | "receipt_label";
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

function normalizeLookupKey(value: unknown): string {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

function cleanLookupLabel(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
