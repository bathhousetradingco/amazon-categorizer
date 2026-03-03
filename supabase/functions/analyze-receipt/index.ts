import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  HttpError,
  corsHeaders,
  getRequiredEnv,
  jsonResponse,
  parseJsonBody,
  toHttpError,
} from "../_shared/http.ts";
import { fetchWithTimeout } from "../_shared/fetch.ts";
import {
  buildOcrInput,
  requestTabscannerExtraction,
  extractJsonFromModelResponse,
  normalizeIncomingFilePath,
  parseCurrencyToNumber,
  parseReceiptItems,
  parseTax,
  prepareReceiptAsset,
  safeParseJsonResponse,
} from "../_shared/receipt.ts";
import { enrichLineItems } from "../_shared/enrich-line-items.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");
const OPENAI_API_KEY = getRequiredEnv("OPENAI_API_KEY");
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") ?? undefined;
const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? undefined;

const CATEGORY_BLOCKLIST = new Set(["other", "general", "unknown", "needs review"]);
const EXTERNAL_FETCH_TIMEOUT_MS = 15000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    console.log("ANALYZE_RECEIPT_START", { ts: Date.now() });
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);

    const filePath = normalizeIncomingFilePath(body.filePath);
    const forceReanalyze = body.forceReanalyze === true;

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await assertReceiptBelongsToUser(adminClient, user.id, filePath);

    if (!forceReanalyze) {
      const cached = await loadCachedReceiptAnalysis({
        adminClient,
        userId: user.id,
        filePath,
      });

      if (cached) {
        console.log("RECEIPT_ANALYSIS_CACHE_HIT", { user_id: user.id, file_path: filePath });
        return jsonResponse({
          success: true,
          data: {
            ...cached.analysis,
            user_state: cached.userState,
          },
          meta: {
            user_id: user.id,
            source: "stored",
            cached: true,
            last_analyzed_at: cached.lastAnalyzedAt,
          },
        });
      }

      console.log("RECEIPT_ANALYSIS_CACHE_MISS", { user_id: user.id, file_path: filePath });
    } else {
      console.log("RECEIPT_ANALYSIS_FORCE_REANALYZE", { user_id: user.id, file_path: filePath });
    }

    const categories = await loadExistingCategories({
      adminClient,
      userId: user.id,
      bodyCategories: body.categories,
    });

    const blob = await downloadReceiptBlob(adminClient, filePath);
    const receiptAsset = await prepareReceiptAsset(filePath, blob);

    console.log({ step: "RECEIPT_PARSE_START", ts: Date.now() });
    const tabscannerData = await requestTabscannerExtraction({
      asset: receiptAsset,
      apiKey: TABSCANNER_API_KEY,
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
    });
    const extractionPayload = await requestReceiptExtraction(receiptAsset, tabscannerData);
    const parsed = extractJsonFromModelResponse(extractionPayload);
    console.log({ step: "RECEIPT_PARSE_END", ts: Date.now(), parsed: Boolean(parsed) });

    if (!parsed) {
      throw new HttpError(422, "OCR did not return parseable JSON", {
        model_response_keys: Object.keys(extractionPayload ?? {}),
      });
    }

    const store = detectStoreType(parsed.store, parsed.merchant, tabscannerData?.store, tabscannerData?.merchant);
    const lineItems = parseReceiptItems(mergeReceiptItems(parsed.items, tabscannerData?.items), { store });
    if (!lineItems.length) {
      throw new HttpError(422, "No valid line items detected", {
        item_count_from_model: Array.isArray(parsed.items) ? parsed.items.length : 0,
      });
    }

    const enrichedLineItems = await enrichLineItems({
      adminClient,
      items: lineItems,
      openAiApiKey: OPENAI_API_KEY,
      serpApiKey: SERPAPI_API_KEY,
      store,
    });

    const receiptTotal = parseCurrencyToNumber(firstFiniteNumber(tabscannerData?.total, parsed.total));
    const reconciledLineItems = reconcileLineItemsWithReceiptTotal(enrichedLineItems, receiptTotal);

    const categorySuggestions = await Promise.all(
      reconciledLineItems.map((item) => suggestCategories(item.enrichedName, categories, OPENAI_API_KEY)),
    );

    const lineItemsTotal = toMoney(reconciledLineItems.reduce((sum, item) => sum + (item.total || 0), 0));
    const totalMismatch = Number.isFinite(receiptTotal) && Math.abs(lineItemsTotal - receiptTotal) > 0.75;

    const problematicLineItems = reconciledLineItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.totalMismatch || item.needsReview)
      .map(({ index }) => index);

    const responsePayload = {
      success: true,
      data: {
        line_items: reconciledLineItems.map((item, index) => {
          const suggested_categories = categorySuggestions[index];
          const enrichedSuggestions = suggested_categories.length ? suggested_categories : fallbackCategorySuggestion(categories);
          const reviewReasons = [
            ...(item.reviewReasons ?? []),
            ...(enrichedSuggestions.length ? [] : ["no category match"]),
          ];
          const needsReview = item.needsReview || item.totalMismatch || reviewReasons.length > 0;

          return {
            raw_description: item.rawName,
            normalized_description: item.name,
            enriched_description: item.enrichedName,
            amount: item.amount,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            line_total: item.total,
            total_mismatch: item.totalMismatch,
            suggested_category: enrichedSuggestions[0]?.name ?? null,
            suggested_categories: enrichedSuggestions,
            product_code: item.code,
            sku: item.sku,
            enrichment_source: item.enrichmentSource,
            brand: item.brand,
            product_category: item.category,
            quality_score: item.qualityScore,
            needs_review: needsReview,
            needs_review_reason: Array.from(new Set(reviewReasons)).join(", ") || null,
            quality_flags: item.qualityFlags,
            original_description: item.originalName ?? item.name,
          };
        }),
        tax_amount: parseTax(firstFiniteNumber(tabscannerData?.tax, parsed.tax)),
        receipt_total: Number.isFinite(receiptTotal) ? receiptTotal : null,
        computed_total: lineItemsTotal,
        totals_match: !totalMismatch,
        problematic_line_items: problematicLineItems,
        file_path: filePath,
        store,
        user_state: {},
      },
      meta: {
        user_id: user.id,
        line_item_count: lineItems.length,
        receipt_needs_review: totalMismatch || problematicLineItems.length > 0,
        source: "fresh",
        cached: false,
      },
    };

    await persistReceiptAnalysis({
      adminClient,
      userId: user.id,
      filePath,
      analysis: responsePayload.data,
      clearUserState: true,
    });

    console.log("RECEIPT_ANALYSIS_STORED", { user_id: user.id, file_path: filePath });
    console.log("ANALYZE_RECEIPT_END", { ts: Date.now() });
    return jsonResponse(responsePayload);
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    console.error("analyze-receipt error", {
      status: httpError.status,
      message: httpError.message,
      details: httpError.details,
    });

    console.log("ANALYZE_RECEIPT_END", { ts: Date.now(), success: false });
    return jsonResponse(
      {
        success: false,
        error: {
          code: `ANALYZE_RECEIPT_${httpError.status}`,
          message: httpError.message,
          details: httpError.details ?? null,
        },
      },
      httpError.status,
    );
  }
});

async function requireAuthenticatedUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new HttpError(401, "Missing Authorization header");

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });

  const { data: userData, error } = await authClient.auth.getUser();
  if (error || !userData.user) {
    throw new HttpError(401, "Invalid or expired JWT", error ? { auth_error: error.message } : undefined);
  }

  return userData.user;
}

async function loadCachedReceiptAnalysis(params: {
  adminClient: ReturnType<typeof createClient>;
  userId: string;
  filePath: string;
}): Promise<{ analysis: Record<string, unknown>; userState: Record<string, unknown>; lastAnalyzedAt: string | null } | null> {
  const { data, error } = await params.adminClient
    .from("receipt_analyses")
    .select("analysis_data, user_state, last_analyzed_at")
    .eq("user_id", params.userId)
    .eq("file_path", params.filePath)
    .maybeSingle();

  if (error) {
    if (isReceiptAnalysisCacheUnavailable(error)) {
      console.warn("Receipt analysis cache unavailable; continuing without cache", {
        code: error.code,
        message: error.message,
      });
      return null;
    }

    throw new HttpError(500, "Failed to load cached receipt analysis", { db_error: error.message });
  }

  if (!data || typeof data.analysis_data !== "object" || !data.analysis_data) return null;

  const userState = (typeof data.user_state === "object" && data.user_state)
    ? data.user_state as Record<string, unknown>
    : {};

  return {
    analysis: data.analysis_data as Record<string, unknown>,
    userState,
    lastAnalyzedAt: typeof data.last_analyzed_at === "string" ? data.last_analyzed_at : null,
  };
}

async function persistReceiptAnalysis(params: {
  adminClient: ReturnType<typeof createClient>;
  userId: string;
  filePath: string;
  analysis: Record<string, unknown>;
  clearUserState: boolean;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    user_id: params.userId,
    file_path: params.filePath,
    analysis_data: params.analysis,
    last_analyzed_at: new Date().toISOString(),
  };

  if (params.clearUserState) {
    payload.user_state = {};
  }

  const { error } = await params.adminClient
    .from("receipt_analyses")
    .upsert(payload, { onConflict: "user_id,file_path" });

  if (error) {
    if (isReceiptAnalysisCacheUnavailable(error)) {
      console.warn("Receipt analysis cache unavailable; skipping persistence", {
        code: error.code,
        message: error.message,
      });
      return;
    }

    throw new HttpError(500, "Failed to persist receipt analysis", { db_error: error.message });
  }
}

function isReceiptAnalysisCacheUnavailable(error: { code?: string; message?: string }): boolean {
  if (!error) return false;
  if (
    error.code === "42P01"
    || error.code === "42703"
    || error.code === "PGRST205"
    || error.code === "PGRST204"
  ) {
    return true;
  }

  const message = (error.message ?? "").toLowerCase();
  return message.includes("receipt_analyses") && (
    message.includes("does not exist")
    || message.includes("undefined table")
    || message.includes("column")
    || message.includes("schema cache")
    || message.includes("could not find")
  );
}

async function assertReceiptBelongsToUser(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  filePath: string,
): Promise<void> {
  const { data, error } = await adminClient
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("receipt_url", filePath)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Unable to validate receipt ownership", { db_error: error.message });
  }

  if (!data) {
    throw new HttpError(403, "Receipt does not belong to authenticated user", { file_path: filePath });
  }
}

async function loadExistingCategories(params: {
  adminClient: ReturnType<typeof createClient>;
  userId: string;
  bodyCategories: unknown;
}): Promise<string[]> {
  const fromBody = sanitizeCategories(params.bodyCategories);
  if (fromBody.length) return fromBody;

  const { data, error } = await params.adminClient
    .from("categories")
    .select("name")
    .eq("user_id", params.userId)
    .order("name", { ascending: true });

  if (!error && data?.length) {
    return sanitizeCategories(data.map((row: { name: string }) => row.name));
  }

  const { data: fallbackData, error: fallbackError } = await params.adminClient
    .from("categories")
    .select("name")
    .order("name", { ascending: true });

  if (!fallbackError && fallbackData?.length) {
    return sanitizeCategories(fallbackData.map((row: { name: string }) => row.name));
  }

  throw new HttpError(422, "No categories available. Pass categories or populate categories table.");
}

function sanitizeCategories(categories: unknown): string[] {
  const list = Array.isArray(categories)
    ? categories.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];

  const seen = new Set<string>();
  const output: string[] = [];

  for (const name of list) {
    if (CATEGORY_BLOCKLIST.has(name.toLowerCase())) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    output.push(name);
    if (output.length >= 100) break;
  }

  return output;
}

type CategorySuggestion = { name: string; confidence: number };


function fallbackCategorySuggestion(categories: string[]): CategorySuggestion[] {
  if (!categories.length) return [];
  return [{ name: categories[0], confidence: 0.12 }];
}

async function suggestCategories(itemName: string, categories: string[], openAiApiKey: string): Promise<CategorySuggestion[]> {
  if (!categories.length) return [];

  const ruleBased = suggestCategoriesByRules(itemName, categories);
  if (ruleBased.length >= 2) return ruleBased.slice(0, 3);

  const aiFallback = await suggestCategoriesByAi(itemName, categories, openAiApiKey);
  const merged = [...ruleBased];

  for (const suggestion of aiFallback) {
    if (!merged.some((entry) => entry.name.toLowerCase() === suggestion.name.toLowerCase())) {
      merged.push(suggestion);
    }
    if (merged.length >= 3) break;
  }

  if (!merged.length) return fallbackCategorySuggestion(categories);
  return merged.slice(0, 3);
}

function suggestCategoriesByRules(itemName: string, categories: string[]): CategorySuggestion[] {
  const lowered = itemName.toLowerCase();
  const scored = categories
    .map((category) => {
      const categoryLower = category.toLowerCase();
      let score = 0;

      if (lowered.includes(categoryLower)) score += 0.9;

      const categoryTokens = categoryLower.split(/\s+/).filter((token) => token.length >= 3);
      for (const token of categoryTokens) {
        if (lowered.includes(token)) score += 0.22;
      }

      if (/(pen|paper|notebook|ink|staple|label|printer)/i.test(lowered) && /office|supply/i.test(category)) score += 0.75;
      if (/(toilet\s*paper|tissue|paper\s*towel|bath\s*tissue|charmin)/i.test(lowered) && /office|supply/i.test(category)) score -= 0.5;
      if (/(toilet\s*paper|tissue|paper\s*towel|bath\s*tissue|charmin)/i.test(lowered) && /clean|janitorial|house|cogs|inventory/i.test(category)) score += 0.65;
      if (/(chicken|beef|milk|grocery|produce|fruit|vegetable|snack|yogurt|coconut|oil|sugar)/i.test(lowered) && /inventory|cogs|food|grocery|ingredient/i.test(category)) score += 0.7;
      if (/(soap|clean|bleach|detergent|trash|towel)/i.test(lowered) && /clean|janitorial|supply/i.test(category)) score += 0.7;
      if (/(shipping|box|tape|postage|mail)/i.test(lowered) && /shipping|postage/i.test(category)) score += 0.7;

      return { name: category, confidence: Math.min(0.99, Number(score.toFixed(2))) };
    })
    .filter((entry) => entry.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  return scored.slice(0, 3);
}

async function suggestCategoriesByAi(
  itemName: string,
  categories: string[],
  openAiApiKey: string,
): Promise<CategorySuggestion[]> {
  const prompt = [
    "Return 2-3 category suggestions for this receipt item.",
    "Use ONLY exact category names from the provided list.",
    "Never return Other, General, Unknown, or Needs Review.",
    "Output JSON only: {\"suggested_categories\":[{\"name\":string,\"confidence\":number}]}",
    `Item: ${itemName}`,
    `Allowed categories: ${JSON.stringify(categories)}`,
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
      max_output_tokens: 300,
    }),
  }, EXTERNAL_FETCH_TIMEOUT_MS);
  } catch (error) {
    console.error("suggest_categories_openai_failed", { error: String(error) });
    return [];
  }

  console.log({ step: "FETCH_END", name: "openai", status: response.status, ts: Date.now() });

  if (!response.ok) return [];

  const payload = await safeParseJsonResponse(response);
  const parsed = extractJsonFromModelResponse(payload);
  const raw = Array.isArray(parsed?.suggested_categories) ? parsed.suggested_categories : [];

  const normalized = raw
    .map((entry) => ({
      name: String(entry?.name ?? "").trim(),
      confidence: Number(entry?.confidence ?? 0),
    }))
    .map((entry) => {
      const exact = categories.find((category) => category.toLowerCase() === entry.name.toLowerCase());
      return exact ? { name: exact, confidence: Math.max(0.01, Math.min(0.95, entry.confidence || 0.55)) } : null;
    })
    .filter((entry): entry is CategorySuggestion => Boolean(entry))
    .filter((entry) => !CATEGORY_BLOCKLIST.has(entry.name.toLowerCase()));

  return normalized.slice(0, 3);
}

async function downloadReceiptBlob(adminClient: ReturnType<typeof createClient>, filePath: string): Promise<Blob> {
  const { data, error } = await adminClient.storage.from("receipts").download(filePath);

  if (error || !data) {
    throw new HttpError(400, "Failed to download receipt", {
      file_path: filePath,
      storage_error: error?.message ?? "unknown",
    });
  }

  return data;
}


function mergeReceiptItems(primaryItems: unknown, tabscannerItems: unknown): unknown[] {
  const primary = Array.isArray(primaryItems) ? primaryItems : [];
  const secondary = Array.isArray(tabscannerItems) ? tabscannerItems : [];
  if (!secondary.length) return primary;

  const secondaryByCode = new Map<string, any>();
  for (const item of secondary as any[]) {
    const code = String(item?.code ?? "").replace(/^0+/, "").trim();
    if (code) secondaryByCode.set(code, item);
  }

  return primary.map((item: any) => {
    const code = String(item?.code ?? "").replace(/^0+/, "").trim();
    const match = code ? secondaryByCode.get(code) : null;
    if (!match) return item;

    return {
      ...item,
      amount: firstFiniteNumber(match.amount, item?.amount),
      code: item?.code ?? match.code ?? null,
      name: String(item?.name ?? "").trim() || match.name,
    };
  });
}

function firstFiniteNumber(...values: unknown[]): unknown {
  for (const value of values) {
    if (Number.isFinite(parseCurrencyToNumber(value))) return value;
  }
  return values[0] ?? null;
}

function detectStoreType(...candidates: unknown[]): "sams_club" | "walmart" | "generic" {
  const combined = candidates.map((value) => String(value ?? "").toLowerCase()).join(" ");
  const compact = combined.replace(/[^a-z]/g, "");
  if (compact.includes("samsclub") || combined.includes("sam's club") || combined.includes("sams club") || combined.includes("sam club")) {
    return "sams_club";
  }
  if (combined.includes("walmart")) return "walmart";
  return "generic";
}

async function requestReceiptExtraction(
  asset: Awaited<ReturnType<typeof prepareReceiptAsset>>,
  tabscannerData: Awaited<ReturnType<typeof requestTabscannerExtraction>> = null,
) {
  const url = "https://api.openai.com/v1/responses";
  console.log({ step: "FETCH_START", name: "openai", url, ts: Date.now() });

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      input: [
        {
          role: "user",
          content: buildOcrInput(asset, { tabscannerData }),
        },
      ],
      max_output_tokens: 1200,
    }),
  }, EXTERNAL_FETCH_TIMEOUT_MS);
  } catch (error) {
    console.error("receipt_extraction_openai_failed", { error: String(error) });
    throw new HttpError(504, "OpenAI OCR request timed out", {
      file_mime_type: asset.mimeType,
      file_extension: asset.extension,
    });
  }

  console.log({ step: "FETCH_END", name: "openai", status: response.status, ts: Date.now() });

  const payload = await safeParseJsonResponse(response);

  if (!response.ok) {
    throw new HttpError(502, "OpenAI OCR request failed", {
      status: response.status,
      openai_error: payload?.error?.message ?? payload?.raw ?? null,
      file_mime_type: asset.mimeType,
      file_extension: asset.extension,
    });
  }

  return payload;
}


function reconcileLineItemsWithReceiptTotal<T extends { quantity: number; unitPrice: number; total: number; rawName: string; qualityFlags: string[] }>(
  items: T[],
  receiptTotal: number,
): T[] {
  if (!Number.isFinite(receiptTotal) || !items.length) return items;

  const nextItems = items.map((item) => ({ ...item, qualityFlags: [...item.qualityFlags] }));
  const currentTotal = toMoney(nextItems.reduce((sum, item) => sum + (item.total || 0), 0));
  const delta = toMoney(receiptTotal - currentTotal);
  if (Math.abs(delta) <= 0.75) return nextItems;

  const candidateIndexes = nextItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.quantity <= 1 && item.unitPrice > 0 && item.total >= 40)
    .map(({ index }) => index);

  for (const index of candidateIndexes) {
    const item = nextItems[index];
    const ratio = (item.total + delta) / item.unitPrice;
    const inferredQty = Math.round(ratio);

    if (inferredQty <= 1 || inferredQty > 300) continue;
    if (Math.abs(ratio - inferredQty) > 0.03) continue;

    const correctedTotal = toMoney(inferredQty * item.unitPrice);
    const correctedDelta = toMoney(receiptTotal - (currentTotal - item.total + correctedTotal));
    if (Math.abs(correctedDelta) > Math.abs(delta)) continue;

    nextItems[index] = {
      ...item,
      quantity: inferredQty,
      total: correctedTotal,
      qualityFlags: Array.from(new Set([...item.qualityFlags, "reconciled_quantity"])),
    };

    break;
  }

  return nextItems;
}

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}
