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
  extractedProductNumber: string | null;
  normalizedProductNumber: string | null;
};

type SerpLineItemTrace = {
  raw_line_item: string;
  parsed_name: string;
  extracted_product_number: string | null;
  normalized_product_number: string | null;
};

type SerpMatch = {
  title: string;
  snippet: string | null;
  link: string | null;
  query: string;
};

type SerpSearchResult = {
  matches: SerpMatch[];
  rawResponse: unknown;
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
  compact: string | null;
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
    const baseName = extractNameWithoutProductNumber(item.rawName) ?? item.name;
    const parsedName = extractProductName(baseName) ?? baseName;
    const displayName = normalizeProductName(parsedName) || parsedName;
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
    if (!isValidProductNumber(extracted.normalized)) {
      extracted.raw = null;
      extracted.normalized = null;
      extracted.compact = null;
    }
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
      const parsedRawName = extractProductName(item.rawName) ?? item.rawName;
      skuHints.set(sku, {
        rawName: normalizeProductName(parsedRawName) || parsedRawName,
        normalizedName: item.name,
        storeHint: detectStoreHint(item.rawName, item.name),
        extractedProductNumber: extracted.raw,
        normalizedProductNumber: extracted.normalized,
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
      ));

    if (missingSkus.length) {
      if (!serpApiKey && store !== "sams_club") {
        throw new Error("SERPAPI_KEY missing");
      }

      const lookedUp = await lookupSkusViaSerpApi(
        missingSkus.slice(0, SERP_MAX_SKUS_PER_BATCH),
        serpApiKey ?? "",
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
  const currentSource = item.enrichmentSource;
  const incomingPriority = sourcePriority(source);
  const existingPriority = sourcePriority(currentSource);
  if (existingPriority > incomingPriority) {
    console.log({
      step: "NAME_APPLY",
      strategy: source,
      before: item.name_final || item.enrichedName || item.name,
      after: item.name_final || item.enrichedName || item.name,
      source_set: item.enrichmentSource,
      applied: false,
      reason: "lower_priority_source",
    });
    return;
  }

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

function sourcePriority(source: EnrichedReceiptItem["enrichmentSource"]): number {
  switch (source) {
    case "samsclub_site":
      return 5;
    case "serpapi":
      return 4;
    case "cache":
      return 3;
    case "ai_cleanup":
      return 2;
    case "normalized":
      return 1;
    default:
      return 0;
  }
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

    if (store === "sams_club") {
      const samsMatch = await enrichFromSamsClubSearch(sku, budget, {
        raw_line_item: hint?.rawName ?? sku,
        parsed_name: hint?.normalizedName ?? hint?.rawName ?? sku,
        extracted_product_number: hint?.extractedProductNumber ?? null,
        normalized_product_number: hint?.normalizedProductNumber ?? null,
      });

      if (samsMatch) {
        rows.push({
          sku,
          clean_name: samsMatch.enriched_name,
          source: samsMatch.source,
          brand: inferBrand(samsMatch.enriched_name),
          category: null,
          source_url: samsMatch.sourceUrl,
        });
        continue;
      }
    }

    if (!serpApiKey) {
      console.log("SERPAPI_SKIPPED", { reason: "missing_serpapi_key", sku });
      continue;
    }

    const match = await enrichWithSerpAPI(
      sku,
      hint?.rawName ?? hint?.normalizedName ?? "",
      hint?.storeHint ?? "bulk retail",
      serpApiKey,
      serpCache,
      budget,
      {
        raw_line_item: hint?.rawName ?? sku,
        parsed_name: hint?.normalizedName ?? hint?.rawName ?? sku,
        extracted_product_number: hint?.extractedProductNumber ?? null,
        normalized_product_number: hint?.normalizedProductNumber ?? null,
      },
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

async function enrichFromSamsClubSearch(
  productNumber: string,
  budget: EnrichmentBudget,
  trace: SerpLineItemTrace,
): Promise<SerpEnrichmentResult | null> {
  const normalizedItemNumber = normalizeSamsItemNumber(trace.normalized_product_number)
    ?? normalizeSamsItemNumber(trace.extracted_product_number)
    ?? normalizeSamsItemNumber(productNumber);

  if (!normalizedItemNumber) return null;

  const searchUrl = `https://www.samsclub.com/s/${encodeURIComponent(normalizedItemNumber)}`;
  const { payload, status } = await fetchWithRetry(
    new URL(searchUrl),
    { attempts: 2, timeoutMs: SEARCH_TIMEOUT_MS, name: "samsclub", budget, responseType: "text" },
  );

  if (typeof payload !== "string") {
    console.log("SAMS_SEARCH_EMPTY", { normalizedItemNumber, status });
    return null;
  }

  const title = extractFirstSamsSearchTitle(payload);
  if (!title || !isAcceptableSamsProductTitle(title)) return null;

  console.log("SERPAPI_LINE_ITEM_TRACE", {
    ...trace,
    value_sent_to_serpapi: normalizedItemNumber,
    serpapi_response_title: title,
    serpapi_raw_response: null,
    final_product_title_used: title,
    strategy: "samsclub_site",
    phase: "direct_sams_search",
  });

  return {
    enriched_name: cleanProductTitle(title),
    confidence: "high",
    source: "samsclub_site",
    sourceUrl: searchUrl,
  };
}

function extractFirstSamsSearchTitle(html: string): string | null {
  const nextData = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? null;
  if (!nextData) return null;

  try {
    const parsed = JSON.parse(nextData);
    const titles: string[] = [];
    collectCandidateTitles(parsed, titles);
    return titles.find((title) => isAcceptableSamsProductTitle(title)) ?? null;
  } catch {
    return null;
  }
}

function collectCandidateTitles(node: unknown, output: string[]) {
  if (!node || output.length >= 25) return;

  if (Array.isArray(node)) {
    node.forEach((entry) => collectCandidateTitles(entry, output));
    return;
  }

  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if ((key === "title" || key === "name") && typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length >= 6 && !output.includes(normalized)) output.push(normalized);
    }

    if (typeof value === "object" && value) collectCandidateTitles(value, output);
  }
}

async function searchGoogleResults(query: string, serpApiKey: string, strategy: "samsclub_site" | "serpapi", budget: EnrichmentBudget): Promise<SerpSearchResult> {
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
      query,
    }))
    .filter((entry: SerpMatch) => entry.title.length >= 4);

  console.log("SERPAPI_RESPONSE", {
    status: responseStatus,
    hasResults: !!data?.organic_results?.length,
  });

  return { matches: mapped, rawResponse: data };
}

function trimSerpRawResponse(payload: unknown): unknown {
  if (payload == null) return null;
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= 1200) return payload;
    return `${serialized.slice(0, 1200)}...<trimmed:${serialized.length - 1200}_chars>`;
  } catch {
    return "<unserializable_serpapi_payload>";
  }
}

async function enrichWithSerpAPI(
  productNumber: string,
  ocrName: string,
  storeHint: string,
  serpApiKey: string,
  cache: Map<string, SerpEnrichmentResult | null>,
  budget: EnrichmentBudget,
  trace: SerpLineItemTrace,
): Promise<SerpEnrichmentResult | null> {
  const rawItemNumber = String(trace.extracted_product_number ?? productNumber ?? "").trim() || null;
  const normalizedItemNumber = normalizeSamsItemNumber(trace.normalized_product_number)
    ?? normalizeSamsItemNumber(rawItemNumber)
    ?? normalizeSamsItemNumber(productNumber);

  if (!normalizedItemNumber) {
    console.log("SERPAPI_SKIPPED", {
      reason: "SERP_SKIPPED_BAD_QUERY",
      query_attempted: normalizedItemNumber,
    });
    return null;
  }

  const cacheKey = normalizedItemNumber;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const queries = buildSamsSearchQueries(rawItemNumber, normalizedItemNumber);
  const candidates: SerpMatch[] = [];

  for (const query of queries) {
    console.log("SERPAPI_REQUEST", {
      item_number_raw: rawItemNumber,
      item_number_normalized: normalizedItemNumber,
      q: query,
    });
    console.log("SERPAPI_LINE_ITEM_TRACE", {
      ...trace,
      value_sent_to_serpapi: query,
      serpapi_response_title: null,
      serpapi_raw_response: null,
      final_product_title_used: null,
      strategy: "samsclub_site",
      phase: "request",
    });

    const { matches, rawResponse } = await searchGoogleResults(query, serpApiKey, "samsclub_site", budget);
    console.log("SERPAPI_LINE_ITEM_TRACE", {
      ...trace,
      value_sent_to_serpapi: query,
      serpapi_response_title: matches[0]?.title ?? null,
      serpapi_raw_response: trimSerpRawResponse(rawResponse),
      final_product_title_used: null,
      strategy: "samsclub_site",
      phase: "response",
    });

    candidates.push(...matches);
    if (matches.some((match) => validateSamsUrlSearchResult(match, normalizedItemNumber, rawItemNumber).accepted)) {
      break;
    }
  }

  let top: SerpMatch | null = null;
  let topScore = -1;
  for (const current of candidates) {
    const validation = validateSamsUrlSearchResult(current, normalizedItemNumber, rawItemNumber);
    console.log("SERPAPI_CANDIDATE", {
      title: current.title,
      link: current.link,
      accepted: validation.accepted,
      reason: validation.reason,
      query: current.query,
    });

    if (!validation.accepted) continue;
    const candidateScore = scoreSamsCandidate(current, normalizedItemNumber, rawItemNumber, ocrName, storeHint);
    if (candidateScore > topScore) {
      top = current;
      topScore = candidateScore;
    }
  }

  if (!top) {
    cache.set(cacheKey, null);
    return null;
  }

  const confidence = scoreEnrichmentConfidence(top, normalizedItemNumber, storeHint, ocrName);
  const enrichment: SerpEnrichmentResult = {
    enriched_name: cleanProductTitle(top.title || top.snippet || ocrName),
    confidence,
    source: "samsclub_site",
    sourceUrl: top.link,
  };

  cache.set(cacheKey, enrichment);
  console.log("SERPAPI_SELECTED", {
    title: top.title,
    link: top.link,
    reason: "url_contains_id",
  });
  console.log("SERPAPI_LINE_ITEM_TRACE", {
    ...trace,
    value_sent_to_serpapi: null,
    serpapi_response_title: top.title ?? null,
    serpapi_raw_response: null,
    final_product_title_used: enrichment.enriched_name,
    query_used: top.query,
    strategy: "samsclub_site",
    phase: "selected_enrichment",
  });
  return enrichment;
}

function buildSamsSearchQueries(rawItemNumber: string | null, normalizedItemNumber: string): string[] {
  const variants = Array.from(new Set([
    rawItemNumber,
    normalizedItemNumber,
    normalizedItemNumber.padStart(10, "0"),
    normalizedItemNumber.padStart(11, "0"),
  ].filter((value): value is string => Boolean(value))));

  const queries: string[] = [];
  for (const candidate of variants) {
    queries.push(`site:samsclub.com ${candidate}`);
    queries.push(`site:samsclub.com "${candidate}"`);
  }

  return Array.from(new Set(queries));
}

function scoreSamsCandidate(
  match: SerpMatch,
  normalizedItemNumber: string,
  rawItemNumber: string | null,
  ocrName: string,
  storeHint: string,
): number {
  let score = 0;
  const validation = validateSamsUrlSearchResult(match, normalizedItemNumber, rawItemNumber);
  if (!validation.accepted) return score;

  score += 4;
  const title = `${match.title} ${match.snippet ?? ""}`;
  if (hasSemanticTokenOverlap(ocrName, title)) score += 3;
  if (titleContainsReadableProductName(match.title)) score += 2;
  if ((match.link ?? "").toLowerCase().includes("/p/")) score += 1;
  if (scoreEnrichmentConfidence(match, normalizedItemNumber, storeHint, ocrName) === "high") score += 2;
  return score;
}

async function fetchWithRetry(url: URL, options: { attempts: number; timeoutMs: number; name: string; budget: EnrichmentBudget; responseType?: "json" | "text" }): Promise<{ payload: any | null; status: number | null }> {
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
      if (options.responseType === "text") {
        return { payload: await response.text(), status: response.status };
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
  normalizedNumber: string | null,
  storeHint: string,
  ocrName: string,
): "high" | "medium" | "low" {
  const text = `${match.title} ${match.snippet ?? ""}`.toLowerCase();
  const hasNumber = normalizedNumber ? text.includes(normalizedNumber.toLowerCase()) : false;
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
  const directCandidates = [item.sku, item.code, runtimeProductCode]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0)
    .map((value) => ({ raw: value, compact: compactIdentifier(value), normalized: normalizeIdentifier(value) }))
    .filter((entry) => isValidProductNumber(entry.normalized));

  const raw = directCandidates[0]?.raw ?? null;

  if (raw) {
    return {
      raw,
      normalized: normalizeIdentifier(raw),
      compact: compactIdentifier(raw),
    };
  }

  const fallback = String(item.rawName ?? "").match(/\d{6,14}/g) ?? [];
  const seededRaw = fallback
    .map((value) => ({ raw: value, compact: compactIdentifier(value) }))
    .filter((entry) => isValidProductNumber(entry.compact))
    .sort((a, b) => b.compact.length - a.compact.length)[0]?.raw ?? null;
  return {
    raw: seededRaw,
    normalized: normalizeIdentifier(seededRaw),
    compact: compactIdentifier(seededRaw),
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
  const compact = compactIdentifier(input);
  if (!compact) return null;
  return isValidProductNumber(compact) ? compact : null;
}

function isValidProductNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[0-9]{6,14}$/.test(String(value));
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
  const withoutProductNumber = rawLine
    .replace(/^\s*(?:#|item\s*#?\s*)?(?=[0-9-]{6,20}\b)[0-9-]{6,20}\s+/, "")
    .trim();
  return withoutProductNumber || null;
}

function extractProductNumberFromLine(rawLine: string): ProductNumberExtraction {
  const tokens = String(rawLine ?? "").match(/\d{6,14}/g) ?? [];
  const candidates = tokens
    .map((token) => ({ raw: token, compact: compactIdentifier(token), normalized: normalizeIdentifier(token) }))
    .filter((entry) => isValidProductNumber(entry.normalized))
    .sort((a, b) => {
      return (b.compact?.length ?? 0) - (a.compact?.length ?? 0);
    });

  const best = candidates[0];
  if (!best) return { raw: null, normalized: null, compact: null };
  return { raw: best.raw, normalized: best.normalized, compact: best.compact };
}

function validateSamsUrlSearchResult(
  match: SerpMatch,
  normalizedItemNumber: string,
  rawItemNumber: string | null,
): { accepted: boolean; reason: string } {
  const link = match.link ?? "";
  if (!isLikelySamsProductUrl(link)) return { accepted: false, reason: "invalid_sams_product_url" };
  const hasItemNumberInUrl = urlContainsItemNumber(link, normalizedItemNumber, rawItemNumber);
  const queryTargetsItemNumber = queryContainsItemNumber(match.query, normalizedItemNumber, rawItemNumber);
  if (!hasItemNumberInUrl && !queryTargetsItemNumber) return { accepted: false, reason: "missing_item_number_signal" };
  if (!isAcceptableSamsProductTitle(match.title)) return { accepted: false, reason: "blocked_title" };
  return { accepted: true, reason: hasItemNumberInUrl ? "url_contains_id" : "query_contains_id" };
}

function queryContainsItemNumber(query: string | null, normalized: string, raw: string | null): boolean {
  const lowered = String(query ?? "").toLowerCase();
  if (!lowered) return false;
  const variants = buildItemNumberVariants(normalized, raw);
  return variants.some((token) => lowered.includes(token));
}

function isLikelySamsProductUrl(url: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith("samsclub.com")) return false;

    const path = parsed.pathname.toLowerCase();
    const isProductPath = path.includes("/p/") || path.includes("/product/");
    if (!isProductPath) return false;

    const blockedPath = ["/search", "/c/", "/category", "/login", "/account", "/content", "/help", "/s/"];
    if (blockedPath.some((token) => path.includes(token))) return false;

    return true;
  } catch {
    return false;
  }
}

function urlContainsItemNumber(url: string, normalized: string, raw: string | null): boolean {
  const lowered = url.toLowerCase();
  const variants = buildItemNumberVariants(normalized, raw);
  return variants.some((token) => lowered.includes(token));
}

function buildItemNumberVariants(normalized: string, raw: string | null): string[] {
  const normalizedDigits = String(normalized ?? "").replace(/\D/g, "");
  const rawDigits = String(raw ?? "").replace(/\D/g, "");
  const candidates = [
    normalizedDigits,
    rawDigits,
    normalizedDigits.padStart(10, "0"),
    normalizedDigits.padStart(11, "0"),
  ];

  return Array.from(new Set(candidates
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 6)));
}

function isAcceptableSamsProductTitle(title: string | null): boolean {
  const normalizedTitle = String(title ?? "").trim();
  if (!normalizedTitle) return false;

  const lowered = normalizedTitle.toLowerCase();
  if (normalizedTitle.endsWith("?")) return false;

  const blockedTokens = [
    "difference between",
    "how to",
    "guide",
    "review",
    "haul",
    "youtube",
    "reddit",
    "facebook",
    "community",
    "donation",
    "login",
  ];

  if (blockedTokens.some((token) => lowered.includes(token))) return false;
  if (!titleContainsReadableProductName(normalizedTitle)) return false;
  return true;
}

function titleContainsReadableProductName(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/^"?\d{8,14}"?(\s*\(\d+\+\))?$/.test(normalized)) return false;
  const alphaTokens = normalized.split(/[^a-zA-Z]+/).filter((token) => token.length >= 3);
  return alphaTokens.length >= 2;
}

function normalizeSamsItemNumber(input: string | null | undefined): string | null {
  const digits = String(input ?? "").trim();
  if (!/^\d+$/.test(digits)) return null;
  const normalized = digits.replace(/^0+/, "");
  return normalized || null;
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


function compactIdentifier(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = String(input).replace(/[^A-Za-z0-9]/g, "").trim();
  return compact || null;
}

function isLikelyProductCode(compact: string | null): boolean {
  return isValidProductNumber(compact);
}

function extractProductName(raw: string | null | undefined): string | null {
  if (!raw) return null;

  return raw
    .replace(/\b\d+\s*AT\s*\d+\s*FOR\s*\d+(\.\d+)?\b/gi, "")
    .replace(/\b\d+\s*FOR\s*\d+(\.\d+)?\b/gi, "")
    .replace(/\bB\s*\d+\s*AT\s*\d+\b/gi, "")
    .replace(/\$\d+(\.\d+)?/g, "")
    .replace(/\b\d+(\.\d+)?\b/g, "")
    .trim() || null;
}

function normalizeProductName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanProductTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed) return trimmed;
  const stripped = trimmed
    .replace(/\s+[|\-–]\s+(sam'?s club|walmart|costco|target|amazon).*$/i, "")
    .replace(/\s*:\s*buy\s+online.*$/i, "")
    .replace(/\s*\|\s*official\s+site.*$/i, "")
    .trim();
  return stripped || trimmed;
}
