import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ParsedReceiptItem } from "./receipt.ts";
import { fetchWithTimeout } from "./fetch.ts";

export type EnrichedReceiptItem = ParsedReceiptItem & {
  enrichedName: string;
  originalName: string;
  name_original: string;
  name_enriched: string;
  name_final: string;
  item_number_raw: string | null;
  normalized_item_number: string | null;
  enrichmentSource: "samsclub_site" | "serpapi" | "cache" | "ai_cleanup" | "normalized" | "none";
  enrichment_source: "samsclub_site" | "serpapi" | "cache" | "ai_cleanup" | "normalized" | "none";
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
  source: "samsclub_site" | "serpapi";
  sourceUrl: string | null;
};

type ProductNumberExtraction = {
  raw: string | null;
  normalized: string | null;
};

const SEARCH_TIMEOUT_MS = 4500;
const SERP_MAX_SKUS_PER_BATCH = 12;
const EXTERNAL_FETCH_TIMEOUT_MS = 12000;
const MAX_LOOKUPS = 15;
const MAX_ENRICHMENT_MS = 25000;

export async function enrichLineItems(params: {
  adminClient: ReturnType<typeof createClient>;
  items: ParsedReceiptItem[];
  openAiApiKey: string;
  serpApiKey?: string;
  store?: string;
}): Promise<EnrichedReceiptItem[]> {
  const { adminClient, items, openAiApiKey, serpApiKey } = params;
  const store = normalizeStoreForLookup(params.store);
  const startedAt = Date.now();
  const budget = {
    startedAt,
    maxMs: MAX_ENRICHMENT_MS,
    maxLookups: MAX_LOOKUPS,
    lookupsUsed: 0,
  };
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
      enrichmentSource: "none",
      enrichment_source: "none",
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
    const extracted = extractProductNumber(item);
    item.item_number_raw = extracted.raw;
    item.normalized_item_number = extracted.normalized;
    console.log({
      step: "ENRICH_START",
      store,
      normalized: extracted.normalized,
      original: item.name,
    });
    console.log({
      step: "PRODUCT_NUMBER_EXTRACTED",
      raw: extracted.raw,
      normalized: extracted.normalized,
      ocr_name: item.rawName,
    });

    const sku = extracted.normalized;
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
        applyLookup(result[index], row.clean_name, "cache", row.brand, row.category, "lookup:cache");
      }
    }

    const unresolvedIndices = result
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => shouldRunSerpLookup(item, skuByIndex.get(index) ?? null))
      .map(({ index }) => index);

    const missingSkus = Array.from(new Set(unresolvedIndices
      .map((index) => normalizeIdentifier(skuByIndex.get(index) ?? result[index].normalized_item_number ?? result[index].sku))
      .filter((sku): sku is string => Boolean(sku))
      )));

    if (missingSkus.length) {
      if (!serpApiKey) {
        throw new Error("SERPAPI_KEY missing");
      }

      const lookedUp = await lookupSkusViaSerpApi(
        missingSkus.slice(0, SERP_MAX_SKUS_PER_BATCH),
        serpApiKey,
        skuHints,
        store,
        budget,
      );

      for (const row of lookedUp) {
        await upsertCacheRow(adminClient, row);
        for (const index of skuMap.get(row.sku) ?? []) {
          const source = row.source === "samsclub_site" ? "samsclub_site" : "serpapi";
          applyLookup(result[index], row.clean_name, source, row.brand, row.category, `lookup:${source}`);
        }
      }
    }
  }

  const unresolved = result
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.enrichmentSource === "none" || item.enrichmentSource === "normalized");

  if (unresolved.length) {
    if (isBudgetExceeded(budget)) {
      console.log({ step: "GLOBAL_TIMEOUT", phase: "ai_cleanup", elapsedMs: Date.now() - budget.startedAt });
    }

    const cleaned = isBudgetExceeded(budget) ? [] : await aiCleanupNames(
      unresolved.map(({ item }) => ({ name: item.enrichedName, sku: item.sku })),
      openAiApiKey,
    );

    cleaned.forEach((name, idx) => {
      const target = unresolved[idx];
      if (!target || !name) return;
      console.log({ step: "AI_CLEANUP_FALLBACK", reason: "no acceptable match from serp strategies", index: target.index });
      applyLookup(result[target.index], name, "ai_cleanup", null, null, "lookup:ai_cleanup");
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
    store: "generic",
  });

  return single;
}

function applyLookup(
  item: EnrichedReceiptItem,
  cleanName: string,
  source: EnrichedReceiptItem["enrichmentSource"],
  brand: string | null,
  category: string | null,
  reason = "enriched",
) {
  if (item.enrichmentSource === "serpapi" || item.enrichmentSource === "samsclub_site") {
    console.log({
      step: "NAME_APPLY",
      strategy: source,
      before: item.name_final || item.enrichedName || item.name,
      after: item.name_final || item.enrichedName || item.name,
      source_set: item.enrichmentSource,
      applied: false,
      reason: "protected_existing_enrichment",
    });
    return;
  }

  const nextName = cleanName.trim();
  const before = item.name_final || item.enrichedName || item.name;
  if (!nextName) {
    console.log({ step: "NAME_APPLY", strategy: source, before, after: before, source_set: item.enrichmentSource, applied: false, reason: "empty_candidate" });
    return;
  }

  item.name = nextName;
  item.enrichedName = nextName;
  item.name_enriched = nextName;
  item.name_final = nextName;
  item.enrichmentSource = source;
  item.enrichment_source = source;
  item.brand = brand;
  item.category = category;
  item.qualityScore = Math.max(item.qualityScore, source === "normalized" || source === "none" ? 0.65 : 0.88);
  console.log({ step: "NAME_APPLY", strategy: source, before, after: nextName, source_set: source, applied: true, reason });
}

function shouldRunSerpLookup(_item: EnrichedReceiptItem, productNumber: string | null): boolean {
  if (!productNumber) {
    console.log("SERPAPI_SKIPPED", { reason: "missing_sku_or_product_code" });
    return false;
  }

  return true;
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

  if (["normalized", "none"].includes((item as EnrichedReceiptItem).enrichmentSource) && isLowConfidenceName(candidateName)) {
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

type EnrichmentBudget = {
  startedAt: number;
  maxMs: number;
  maxLookups: number;
  lookupsUsed: number;
};

async function lookupSkusViaSerpApi(
  skus: string[],
  serpApiKey: string,
  skuHints: Map<string, LookupHint>,
  store: "sams_club" | "walmart" | "generic",
  budget: EnrichmentBudget,
): Promise<ProductLookupRow[]> {
  const rows: ProductLookupRow[] = [];
  const serpCache = new Map<string, SerpEnrichmentResult | null>();

  for (const sku of skus) {
    if (isBudgetExceeded(budget)) {
      console.log({ step: "GLOBAL_TIMEOUT", phase: "serp_lookup", elapsedMs: Date.now() - budget.startedAt, lookupsUsed: budget.lookupsUsed });
      break;
    }

    if (budget.lookupsUsed >= budget.maxLookups) {
      console.log({ step: "LOOKUP_CAP_REACHED", lookupsUsed: budget.lookupsUsed, maxLookups: budget.maxLookups });
      break;
    }

    budget.lookupsUsed += 1;
    const hint = skuHints.get(sku);
    const lineItem = {
      sku,
      product_code: sku,
    };
    console.log("SERPAPI_ATTEMPT", {
      sku: lineItem.sku,
      product_code: lineItem.product_code,
      store,
    });
    const match = await enrichWithSerpAPI(
      sku,
      hint?.rawName ?? hint?.normalizedName ?? "",
      hint?.storeHint ?? "bulk retail",
      serpApiKey,
      serpCache,
      budget,
    );

    if (!match) {
      console.log("SERPAPI_SKIPPED", { reason: "no_product_match" });
      console.log({ step: "NAME_APPLY", before: hint?.rawName ?? sku, after: hint?.rawName ?? sku, applied: false, reason: "no_product_match" });
      continue;
    }

    rows.push({
      sku,
      clean_name: match.enriched_name,
      source: match.source,
      brand: inferBrand(match.enriched_name),
      category: null,
      source_url: match.sourceUrl,
    });
  }

  return rows;
}

async function searchGoogleResults(query: string, serpApiKey: string, strategy: "samsclub_site" | "serpapi", budget: EnrichmentBudget): Promise<SerpMatch[]> {
  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google");
  url.searchParams.set("location", "United States");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", serpApiKey);
  url.searchParams.set("num", "5");

  console.log("SERPAPI_QUERY", { query, url: url.toString() });

  const { payload: data, status: responseStatus } = await fetchWithRetry(url, { attempts: 2, timeoutMs: SEARCH_TIMEOUT_MS, name: "serpapi", budget });
  const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];

  const mapped = organic
    .map((entry: any) => ({
      title: String(entry?.title ?? "").trim(),
      snippet: entry?.snippet ? String(entry.snippet).trim() : null,
      link: entry?.link ? String(entry.link) : null,
    }))
    .filter((entry: SerpMatch) => entry.title.length >= 4);

  console.log("SERPAPI_RESPONSE", {
    status: responseStatus,
    hasResults: !!data?.organic_results?.length,
  });

  return mapped;
}

async function enrichWithSerpAPI(
  productNumber: string,
  ocrName: string,
  storeHint: string,
  serpApiKey: string,
  cache: Map<string, SerpEnrichmentResult | null>,
  budget: EnrichmentBudget,
): Promise<SerpEnrichmentResult | null> {
  const normalizedNumber = normalizeIdentifier(productNumber);
  if (!normalizedNumber) {
    console.log("SERPAPI_SKIPPED", { reason: "invalid_product_number" });
    return null;
  }

  if (cache.has(normalizedNumber)) return cache.get(normalizedNumber) ?? null;

  const queries = [
    { query: `site:samsclub.com ${normalizedNumber}`, strategy: "samsclub_site" as const },
    { query: `${normalizedNumber} Sam's Club product`, strategy: "serpapi" as const },
  ];

  let top: SerpMatch | null = null;
  let source: "samsclub_site" | "serpapi" = "serpapi";
  for (const candidate of queries) {
    const matches = await searchGoogleResults(candidate.query, serpApiKey, candidate.strategy, budget);
    const current = matches[0] ?? null;
    if (!current) {
      console.log({ step: "VALIDATION", strategy: candidate.strategy, accepted: false, reason: "no_results" });
      continue;
    }

    const validation = validateSearchResult(current, ocrName, normalizedNumber);
    console.log({ step: "VALIDATION", strategy: candidate.strategy, accepted: validation.accepted, reason: validation.reason });
    if (validation.accepted) {
      top = current;
      source = candidate.strategy;
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
    source,
    sourceUrl: top.link,
  };

  cache.set(normalizedNumber, enrichment);
  return enrichment;
}

async function fetchWithRetry(url: URL, options: { attempts: number; timeoutMs: number; name: string; budget: EnrichmentBudget }): Promise<{ payload: any | null; status: number | null }> {
  let lastError: unknown = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (isBudgetExceeded(options.budget)) {
      console.log({ step: "GLOBAL_TIMEOUT", phase: "fetch_retry", elapsedMs: Date.now() - options.budget.startedAt, url: url.toString() });
      break;
    }

    try {
      console.log({ step: "FETCH_START", name: options.name, url: url.toString(), ts: Date.now(), attempt });
      const response = await fetchWithTimeout(url, {}, options.timeoutMs);
      console.log({ step: "FETCH_END", name: options.name, status: response.status, ts: Date.now(), attempt });
      lastStatus = response.status;
      if (!response.ok) {
        lastError = new Error(`http_${response.status}`);
        continue;
      }
      return { payload: await response.json(), status: response.status };
    } catch (error) {
      lastError = error;
      console.error("external_fetch_failed", { name: options.name, url: url.toString(), attempt, error: String(error) });
    }
  }

  console.log("receipt_enrichment_request_failed", { url: url.toString(), error: String(lastError ?? "unknown") });
  return { payload: null, status: lastStatus };
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


function selectLookupIdentifier(item: ParsedReceiptItem): ProductNumberExtraction {
  const runtimeProductCode = (item as Record<string, unknown>).product_code;
  const raw = [item.sku, item.code, runtimeProductCode]
    .map((value) => String(value ?? "").trim())
    .find((value) => value.length > 0) ?? null;

  if (raw) {
    return {
      raw,
      normalized: normalizeIdentifier(raw),
    };
  }

  const fallback = String(item.rawName ?? "").match(/\b[0-9A-Za-z]{5,18}\b/g) ?? [];
  const seededRaw = fallback.sort((a, b) => b.length - a.length)[0] ?? null;
  return {
    raw: seededRaw,
    normalized: normalizeIdentifier(seededRaw),
  };
}

function extractProductNumber(item: ParsedReceiptItem): ProductNumberExtraction {
  const fromLine = extractProductNumberFromLine(item.rawName);
  if (fromLine.normalized) return fromLine;
  return selectLookupIdentifier(item);
}

function normalizeStoreForLookup(store: string | undefined): "sams_club" | "walmart" | "generic" {
  const compact = String(store ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (compact.includes("samsclub") || compact.includes("samclub") || compact.includes("sams")) return "sams_club";
  if (compact.includes("walmart")) return "walmart";
  return "generic";
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

  const url = "https://api.openai.com/v1/responses";
  console.log({ step: "FETCH_START", name: "openai", url, ts: Date.now() });

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
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
  }, EXTERNAL_FETCH_TIMEOUT_MS);
  } catch (error) {
    console.error("ai_cleanup_openai_failed", { error: String(error) });
    return [];
  }

  console.log({ step: "FETCH_END", name: "openai", status: response.status, ts: Date.now() });

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
  const match = rawLine.match(/^\s*(\d{8,14})\s+/);
  const raw = match?.[1] ?? null;
  const normalized = raw ? normalizeIdentifier(raw) : null;
  return { raw, normalized };
}

function validateSearchResult(
  match: SerpMatch,
  ocrName: string,
  normalizedNumber: string,
): { accepted: boolean; reason: string } {
  const fullText = `${match.title} ${match.snippet ?? ""}`.toLowerCase();
  const domain = (match.link ?? "").toLowerCase();
  if (domain.includes("samsclub.com")) return { accepted: true, reason: "samsclub_domain" };

  const hasNumber = fullText.includes(normalizedNumber);
  const navNoise = /login|sign in|account|cart|help|membership|hours|locations/.test(fullText);
  const keywordHit = /coffee|yogurt|oil|milk|chicken|beef|bread|water|detergent|paper|snack/i.test(fullText);
  if (hasNumber && keywordHit && !navNoise) return { accepted: true, reason: "number_keyword_match" };

  const ocrTokens = tokenizeMeaningful(ocrName);
  const resultTokens = tokenizeMeaningful(`${match.title} ${match.snippet ?? ""}`);
  const overlap = ocrTokens.filter((token) => resultTokens.includes(token)).length;
  if (hasNumber && overlap >= 1) return { accepted: true, reason: "number_token_overlap" };
  if (!hasNumber) return { accepted: false, reason: "missing_product_number" };
  if (navNoise) return { accepted: false, reason: "navigation_noise" };
  return { accepted: false, reason: "insufficient_signal" };
}


function isBudgetExceeded(budget: EnrichmentBudget): boolean {
  return Date.now() - budget.startedAt >= budget.maxMs;
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
