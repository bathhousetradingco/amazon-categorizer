import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ParsedReceiptItem } from "./receipt.ts";

export type EnrichedReceiptItem = ParsedReceiptItem & {
  enrichedName: string;
  originalName: string;
  name_original: string;
  name_enriched: string;
  name_final: string;
  item_number_raw: string | null;
  normalized_item_number: string | null;
  enrichmentSource: "serpapi" | "cache" | "ai_cleanup" | "normalized";
  enrichment_source: "serpapi" | "cache" | "ai_cleanup" | "normalized";
  brand: string | null;
  category: string | null;
  qualityScore: number;
  needsReview: boolean;
  reviewReasons: string[];
};

type ProductLookupRow = {
  sku: string;
  clean_name: string;
  source: string;
  brand: string | null;
  category: string | null;
  source_url?: string | null;
};

type LookupHint = {
  rawName: string;
  normalizedName: string;
  storeHint: string;
};

type SerpMatch = {
  title: string;
  snippet: string | null;
  link: string | null;
};

type SerpEnrichmentResult = {
  enriched_name: string;
  confidence: "high" | "medium" | "low";
  source: "serpapi";
  sourceUrl: string | null;
};

type ProductNumberExtraction = {
  raw: string | null;
  normalized: string | null;
};

const SEARCH_TIMEOUT_MS = 4500;
const SERP_MAX_SKUS_PER_BATCH = 12;

export async function enrichLineItems(params: {
  adminClient: ReturnType<typeof createClient>;
  items: ParsedReceiptItem[];
  openAiApiKey: string;
  serpApiKey?: string;
}): Promise<EnrichedReceiptItem[]> {
  const { adminClient, items, openAiApiKey, serpApiKey } = params;
  const result: EnrichedReceiptItem[] = items.map((item) => {
    const displayName = extractNameWithoutProductNumber(item.rawName) ?? item.name;
    const reasons = collectReviewReasons(item, displayName);
    return {
      ...item,
      originalName: displayName,
      enrichedName: displayName,
      name_original: displayName,
      name_enriched: displayName,
      name_final: displayName,
      name: displayName,
      item_number_raw: null,
      normalized_item_number: null,
      enrichmentSource: "normalized",
      enrichment_source: "normalized",
      brand: null,
      category: null,
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
    };
  });

  const skuMap = new Map<string, number[]>();
  const skuHints = new Map<string, LookupHint>();
  const skuByIndex = new Map<number, string>();
  result.forEach((item, index) => {
    const extracted = extractProductNumberFromLine(item.rawName);
    item.item_number_raw = extracted.raw;
    item.normalized_item_number = extracted.normalized;
    console.log({
      step: "PRODUCT_NUMBER_EXTRACTED",
      raw: extracted.raw,
      normalized: extracted.normalized,
    });

    const sku = extracted.normalized ?? selectLookupIdentifier(item);
    if (!sku) return;
    skuByIndex.set(index, sku);
    if (!item.sku) item.sku = sku;

    const bucket = skuMap.get(sku) ?? [];
    bucket.push(index);
    skuMap.set(sku, bucket);

    if (!skuHints.has(sku)) {
      skuHints.set(sku, {
        rawName: item.rawName,
        normalizedName: item.name,
        storeHint: detectStoreHint(item.rawName, item.name),
      });
    }
  });

  if (skuMap.size) {
    const cached = await fetchCacheRows(adminClient, Array.from(skuMap.keys()));

    for (const [sku, row] of cached.entries()) {
      for (const index of skuMap.get(sku) ?? []) {
        applyLookup(result[index], row.clean_name, "cache", row.brand, row.category);
      }
    }

    const unresolvedIndices = result
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => shouldLookupViaSerp(item, skuByIndex.get(index) ?? null))
      .map(({ index }) => index);

    const missingSkus = Array.from(new Set(unresolvedIndices
      .map((index) => normalizeIdentifier(skuByIndex.get(index) ?? result[index].sku))
      .filter((sku): sku is string => Boolean(sku))
      .filter((sku) => !cached.has(sku))));

    if (missingSkus.length && serpApiKey) {
      const lookedUp = await lookupSkusViaSerpApi(
        missingSkus.slice(0, SERP_MAX_SKUS_PER_BATCH),
        serpApiKey,
        skuHints,
      );

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

  result.forEach((item) => {
    item.reviewReasons = collectReviewReasons(item, item.enrichedName);
    item.needsReview = item.reviewReasons.length > 0;
  });

  return result;
}

export async function enrichProductName(params: {
  adminClient: ReturnType<typeof createClient>;
  item: ParsedReceiptItem;
  openAiApiKey: string;
  serpApiKey?: string;
}): Promise<EnrichedReceiptItem> {
  const [single] = await enrichLineItems({
    adminClient: params.adminClient,
    items: [params.item],
    openAiApiKey: params.openAiApiKey,
    serpApiKey: params.serpApiKey,
  });

  return single;
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

  item.name = nextName;
  item.enrichedName = nextName;
  item.name_enriched = nextName;
  item.name_final = nextName;
  item.enrichmentSource = source;
  item.enrichment_source = source;
  item.brand = brand;
  item.category = category;
  item.qualityScore = Math.max(item.qualityScore, source === "normalized" ? 0.65 : 0.88);
}

function shouldLookupViaSerp(item: EnrichedReceiptItem, productNumber: string | null): boolean {
  if (!productNumber) return false;
  const hasNumericIdentifier = /\d{5,}/.test(productNumber);
  if (item.enrichmentSource !== "normalized") return false;
  return hasNumericIdentifier || item.qualityScore < 0.75 || isLowConfidenceName(item.enrichedName);
}

function isLowConfidenceName(name: string): boolean {
  const compact = name.replace(/\s+/g, " ").trim();
  if (!compact || compact.length < 7) return true;

  const tokens = compact.split(" ").filter(Boolean);
  const alphaTokens = tokens.filter((token) => /[a-z]/i.test(token));
  const numericHeavy = (compact.match(/\d/g)?.length ?? 0) >= Math.ceil(compact.length * 0.4);
  const mostlyUpper = compact === compact.toUpperCase() && /[A-Z]/.test(compact);

  return numericHeavy || mostlyUpper || alphaTokens.length <= 1;
}

function collectReviewReasons(item: ParsedReceiptItem | EnrichedReceiptItem, candidateName: string): string[] {
  const reasons: string[] = [];

  if (item.qualityScore < 0.6 || isLowConfidenceName(candidateName)) reasons.push("low confidence OCR");
  if (item.totalMismatch) reasons.push("price mismatch");

  if ((item as EnrichedReceiptItem).enrichmentSource === "normalized" && isLowConfidenceName(candidateName)) {
    reasons.push("no product match found");
  }

  return Array.from(new Set(reasons));
}

function detectStoreHint(rawName: string, normalizedName: string): string {
  const combined = `${rawName} ${normalizedName}`.toLowerCase();
  if (combined.includes("sam") || combined.includes("member's mark") || combined.includes("members mark")) return "sams club";
  if (combined.includes("walmart") || combined.includes("great value")) return "walmart";
  if (combined.includes("costco") || combined.includes("kirkland")) return "costco";
  return "bulk retail";
}

async function fetchCacheRows(adminClient: ReturnType<typeof createClient>, skus: string[]) {
  const { data, error } = await adminClient
    .from("product_lookup_cache")
    .select("sku, clean_name, source, brand, category")
    .in("normalized_sku", skus);

  if (error || !data) return new Map<string, ProductLookupRow>();
  return new Map((data as ProductLookupRow[]).map((row) => [normalizeIdentifier(row.sku) ?? row.sku, row]));
}

async function upsertCacheRow(adminClient: ReturnType<typeof createClient>, row: ProductLookupRow) {
  await adminClient.from("product_lookup_cache").upsert(
    {
      sku: row.sku,
      clean_name: row.clean_name,
      source: row.source,
      brand: row.brand,
      category: row.category,
      source_url: row.source_url ?? null,
      last_checked_at: new Date().toISOString(),
    },
    { onConflict: "sku" },
  );
}

async function lookupSkusViaSerpApi(
  skus: string[],
  serpApiKey: string,
  skuHints: Map<string, LookupHint>,
): Promise<ProductLookupRow[]> {
  const rows: ProductLookupRow[] = [];
  const serpCache = new Map<string, SerpEnrichmentResult | null>();

  for (const sku of skus) {
    const hint = skuHints.get(sku);
    const match = await enrichWithSerpAPI(
      sku,
      hint?.rawName ?? hint?.normalizedName ?? "",
      hint?.storeHint ?? "bulk retail",
      serpApiKey,
      serpCache,
    );

    if (!match || match.confidence === "low") {
      console.log("receipt_enrichment_failed", { sku, reason: "no_product_match" });
      continue;
    }

    console.log("receipt_enrichment_success", { sku, title: match.enriched_name, confidence: match.confidence });

    rows.push({
      sku,
      clean_name: match.enriched_name,
      source: "serpapi",
      brand: inferBrand(match.enriched_name),
      category: null,
      source_url: match.sourceUrl,
    });
  }

  return rows;
}

async function searchGoogleResults(query: string, serpApiKey: string): Promise<SerpMatch[]> {
  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google");
  url.searchParams.set("location", "United States");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", serpApiKey);
  url.searchParams.set("num", "5");

  const payload = await fetchWithRetry(url, { attempts: 2, timeoutMs: SEARCH_TIMEOUT_MS });
  if (!payload) return [];

  const organic = Array.isArray(payload?.organic_results) ? payload.organic_results : [];

  return organic
    .map((entry: any) => ({
      title: String(entry?.title ?? "").trim(),
      snippet: entry?.snippet ? String(entry.snippet).trim() : null,
      link: entry?.link ? String(entry.link) : null,
    }))
    .filter((entry: SerpMatch) => entry.title.length >= 4);
}

async function enrichWithSerpAPI(
  productNumber: string,
  ocrName: string,
  storeHint: string,
  serpApiKey: string,
  cache: Map<string, SerpEnrichmentResult | null>,
): Promise<SerpEnrichmentResult | null> {
  const normalizedNumber = normalizeIdentifier(productNumber);
  if (!normalizedNumber) return null;

  if (cache.has(normalizedNumber)) return cache.get(normalizedNumber) ?? null;

  const queries = [
    { query: `site:samsclub.com ${normalizedNumber}`, strategy: "samsclub" as const },
    { query: `${normalizedNumber} Sam's Club product`, strategy: "serpapi" as const },
    { query: `${normalizedNumber} ${storeHint} product`, strategy: "serpapi" as const },
  ];

  let top: SerpMatch | null = null;
  for (const candidate of queries) {
    console.log({ step: "SEARCH_QUERY", query: candidate.query, strategy: candidate.strategy });
    const matches = await searchGoogleResults(candidate.query, serpApiKey);
    const current = matches[0] ?? null;
    if (!current) {
      console.log({ step: "SEARCH_RESULT", title: null, accepted: false });
      continue;
    }

    const accepted = isAcceptedSearchResult(current, ocrName);
    console.log({ step: "SEARCH_RESULT", title: current.title, accepted });
    if (accepted) {
      top = current;
      break;
    }
  }

  if (!top) {
    cache.set(normalizedNumber, null);
    return null;
  }

  const confidence = scoreEnrichmentConfidence(top, normalizedNumber, storeHint, ocrName);
  const enrichment: SerpEnrichmentResult = {
    enriched_name: top.title || top.snippet || normalizedNumber,
    confidence,
    source: "serpapi",
    sourceUrl: top.link,
  };

  cache.set(normalizedNumber, enrichment);
  return enrichment;
}

async function fetchWithRetry(url: URL, options: { attempts: number; timeoutMs: number }): Promise<any | null> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        lastError = new Error(`http_${response.status}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  console.log("receipt_enrichment_request_failed", { url: url.toString(), error: String(lastError ?? "unknown") });
  return null;
}

function scoreEnrichmentConfidence(
  match: SerpMatch,
  normalizedNumber: string,
  storeHint: string,
  ocrName: string,
): "high" | "medium" | "low" {
  const text = `${match.title} ${match.snippet ?? ""}`.toLowerCase();
  const hasNumber = text.includes(normalizedNumber.toLowerCase());
  const hasStore = text.includes(storeHint.toLowerCase().split(" ")[0]);
  const inSamsDomain = (match.link ?? "").toLowerCase().includes("samsclub.com");
  const unrelated = /manual|replacement|part|coupon|deal|review|youtube|ebay/i.test(text);

  if (unrelated) return "low";
  if (inSamsDomain && hasNumber) return "high";
  if (hasNumber && hasStore) return "high";
  if (hasSemanticTokenOverlap(ocrName, `${match.title} ${match.snippet ?? ""}`)) return "high";
  if (match.title.length >= 12) return "medium";
  return "low";
}

function inferBrand(name: string): string | null {
  const token = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return token.length >= 3 ? token : null;
}


function selectLookupIdentifier(item: ParsedReceiptItem): string | null {
  const seeded = [item.sku ?? "", item.code ?? "", item.rawName]
    .flatMap((value) => String(value ?? "").match(/\b[0-9A-Za-z]{5,18}\b/g) ?? [])
    .map((token) => normalizeIdentifier(token))
    .filter((token): token is string => Boolean(token))
    .sort((a, b) => b.length - a.length);

  return seeded[0] ?? null;
}

function normalizeIdentifier(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = String(input).replace(/[^A-Za-z0-9]/g, "").trim();
  if (!cleaned) return null;

  const numeric = cleaned.replace(/^0+/, "");
  const normalized = numeric || cleaned;
  return normalized.length >= 5 ? normalized : null;
}

async function aiCleanupNames(items: Array<{ name: string; sku: string | null }>, openAiApiKey: string): Promise<string[]> {
  const prompt = [
    "Clean and expand receipt line item names into user-friendly product titles.",
    "Return JSON only with shape: {\"items\": [{\"clean_name\": string}]}",
    "Rules: expand abbreviations, remove shorthand and store internal codes, keep package size/count when present.",
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

function extractNameWithoutProductNumber(rawLine: string): string | null {
  const withoutProductNumber = rawLine.replace(/^\s*\d{8,14}\s+/, "").trim();
  return withoutProductNumber || null;
}

function extractProductNumberFromLine(rawLine: string): ProductNumberExtraction {
  const match = rawLine.match(/^\s*(\d{8,14})\b/);
  const raw = match?.[1] ?? null;
  const normalized = raw ? normalizeIdentifier(raw) : null;
  return { raw, normalized };
}

function isAcceptedSearchResult(match: SerpMatch, ocrName: string): boolean {
  const fullText = `${match.title} ${match.snippet ?? ""}`.toLowerCase();
  const domain = (match.link ?? "").toLowerCase();
  if (domain.includes("samsclub.com")) return true;

  const keywordHit = /coffee|yogurt|oil|milk|chicken|beef|bread|water|detergent|paper|snack/i.test(fullText);
  if (keywordHit) return true;

  const ocrTokens = tokenizeMeaningful(ocrName);
  const resultTokens = tokenizeMeaningful(`${match.title} ${match.snippet ?? ""}`);
  const overlap = ocrTokens.filter((token) => resultTokens.includes(token)).length;
  return overlap >= 2;
}

function tokenizeMeaningful(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}


function hasSemanticTokenOverlap(source: string, candidate: string): boolean {
  const sourceTokens = tokenizeMeaningful(source);
  const candidateTokens = tokenizeMeaningful(candidate);
  const overlap = sourceTokens.filter((token) => candidateTokens.includes(token)).length;
  return overlap >= 2;
}
