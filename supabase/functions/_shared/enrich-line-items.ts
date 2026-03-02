import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ParsedReceiptItem } from "./receipt.ts";

export type EnrichedReceiptItem = ParsedReceiptItem & {
  enrichedName: string;
  enrichmentSource: "serpapi" | "cache" | "ai_cleanup" | "normalized";
  brand: string | null;
  category: string | null;
  qualityScore: number;
  needsReview: boolean;
};

type ProductLookupRow = {
  sku: string;
  clean_name: string;
  source: string;
  brand: string | null;
  category: string | null;
};

export async function enrichLineItems(params: {
  adminClient: ReturnType<typeof createClient>;
  items: ParsedReceiptItem[];
  openAiApiKey: string;
  serpApiKey?: string;
}): Promise<EnrichedReceiptItem[]> {
  const { adminClient, items, openAiApiKey, serpApiKey } = params;
  const result: EnrichedReceiptItem[] = items.map((item) => ({
    ...item,
    enrichedName: item.name,
    enrichmentSource: "normalized",
    brand: null,
    category: null,
    needsReview: item.qualityScore < 0.65,
  }));

  const skuMap = new Map<string, number[]>();
  result.forEach((item, index) => {
    if (!item.sku) return;
    const bucket = skuMap.get(item.sku) ?? [];
    bucket.push(index);
    skuMap.set(item.sku, bucket);
  });

  if (skuMap.size) {
    const cached = await fetchCacheRows(adminClient, Array.from(skuMap.keys()));

    for (const [sku, row] of cached.entries()) {
      for (const index of skuMap.get(sku) ?? []) {
        applyLookup(result[index], row.clean_name, "cache", row.brand, row.category);
      }
    }

    const missingSkus = Array.from(skuMap.keys()).filter((sku) => !cached.has(sku));
    if (missingSkus.length && serpApiKey) {
      const lookedUp = await lookupSkusViaSerpApi(missingSkus, serpApiKey);
      for (const row of lookedUp) {
        await upsertCacheRow(adminClient, row);
        for (const index of skuMap.get(row.sku) ?? []) {
          applyLookup(result[index], row.clean_name, "serpapi", row.brand, row.category);
        }
      }
    }
  }

  const unresolved = result
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.enrichmentSource === "normalized" || item.needsReview);

  if (unresolved.length) {
    const cleaned = await aiCleanupNames(
      unresolved.map(({ item }) => ({ name: item.enrichedName, sku: item.sku })),
      openAiApiKey,
    );

    cleaned.forEach((name, idx) => {
      const target = unresolved[idx];
      if (!target || !name) return;
      applyLookup(result[target.index], name, "ai_cleanup", null, null);
    });
  }

  return result;
}

function applyLookup(
  item: EnrichedReceiptItem,
  cleanName: string,
  source: EnrichedReceiptItem["enrichmentSource"],
  brand: string | null,
  category: string | null,
) {
  const nextName = cleanName.trim();
  if (!nextName) return;

  item.enrichedName = nextName;
  item.enrichmentSource = source;
  item.brand = brand;
  item.category = category;
  item.needsReview = nextName.length < 5;
  item.qualityScore = Math.max(item.qualityScore, source === "normalized" ? 0.65 : 0.85);
}

async function fetchCacheRows(adminClient: ReturnType<typeof createClient>, skus: string[]) {
  const { data, error } = await adminClient
    .from("product_lookup_cache")
    .select("sku, clean_name, source, brand, category")
    .in("sku", skus);

  if (error || !data) return new Map<string, ProductLookupRow>();
  return new Map((data as ProductLookupRow[]).map((row) => [row.sku, row]));
}

async function upsertCacheRow(adminClient: ReturnType<typeof createClient>, row: ProductLookupRow) {
  await adminClient.from("product_lookup_cache").upsert(
    {
      sku: row.sku,
      clean_name: row.clean_name,
      source: row.source,
      brand: row.brand,
      category: row.category,
    },
    { onConflict: "sku" },
  );
}

async function lookupSkusViaSerpApi(skus: string[], serpApiKey: string): Promise<ProductLookupRow[]> {
  const rows: ProductLookupRow[] = [];

  for (const sku of skus.slice(0, 8)) {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", sku);
    url.searchParams.set("api_key", serpApiKey);

    const response = await fetch(url);
    if (!response.ok) continue;

    const payload = await response.json();
    const first = payload?.shopping_results?.[0];
    if (!first?.title) continue;

    rows.push({
      sku,
      clean_name: String(first.title).trim(),
      source: "serpapi",
      brand: first.brand ? String(first.brand) : null,
      category: first.category ? String(first.category) : null,
    });
  }

  return rows;
}

async function aiCleanupNames(items: Array<{ name: string; sku: string | null }>, openAiApiKey: string): Promise<string[]> {
  const prompt = [
    "Clean and expand receipt line item names into user-friendly product titles.",
    "Return JSON only with shape: {\"items\": [{\"clean_name\": string}]}",
    "Rules: remove shorthand, remove internal SKU noise, keep names concise and specific.",
    `Input: ${JSON.stringify(items)}`,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 600,
    }),
  });

  if (!response.ok) return [];

  const payload = await response.json();
  const text = payload?.output_text ?? payload?.output?.[0]?.content?.[0]?.text;
  if (typeof text !== "string") return [];

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) return [];

  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    const out = Array.isArray(parsed?.items) ? parsed.items : [];
    return out.map((entry: any) => String(entry?.clean_name ?? "").trim());
  } catch {
    return [];
  }
}
