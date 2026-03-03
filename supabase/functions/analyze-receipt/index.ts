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
import {
  buildOcrInput,
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
const SERPAPI_API_KEY = Deno.env.get("SERPAPI_API_KEY") ?? undefined;

const CATEGORY_BLOCKLIST = new Set(["other", "general", "unknown", "needs review"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);

    const filePath = normalizeIncomingFilePath(body.filePath);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await assertReceiptBelongsToUser(adminClient, user.id, filePath);

    const categories = await loadExistingCategories({
      adminClient,
      userId: user.id,
      bodyCategories: body.categories,
    });

    const blob = await downloadReceiptBlob(adminClient, filePath);
    const receiptAsset = await prepareReceiptAsset(filePath, blob);

    const extractionPayload = await requestReceiptExtraction(receiptAsset);
    const parsed = extractJsonFromModelResponse(extractionPayload);

    if (!parsed) {
      throw new HttpError(422, "OCR did not return parseable JSON", {
        model_response_keys: Object.keys(extractionPayload ?? {}),
      });
    }

    const store = detectStoreType(parsed.store, parsed.merchant);
    const lineItems = parseReceiptItems(parsed.items, { store });
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
    });

    const categorySuggestions = await Promise.all(
      enrichedLineItems.map((item) => suggestCategories(item.enrichedName, categories, OPENAI_API_KEY)),
    );

    const receiptTotal = parseCurrencyToNumber(parsed.total);
    const lineItemsTotal = toMoney(enrichedLineItems.reduce((sum, item) => sum + (item.total || 0), 0));
    const totalMismatch = Number.isFinite(receiptTotal) && Math.abs(lineItemsTotal - receiptTotal) > 0.75;

    const problematicLineItems = enrichedLineItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.totalMismatch || item.needsReview)
      .map(({ index }) => index);

    return jsonResponse({
      success: true,
      data: {
        line_items: enrichedLineItems.map((item, index) => {
          const suggested_categories = categorySuggestions[index];
          const needsReview = item.needsReview || item.totalMismatch || suggested_categories.length === 0;

          return {
            raw_description: item.rawName,
            normalized_description: item.name,
            enriched_description: item.enrichedName,
            amount: item.amount,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            line_total: item.total,
            total_mismatch: item.totalMismatch,
            suggested_category: suggested_categories[0]?.name ?? null,
            suggested_categories,
            product_code: item.code,
            sku: item.sku,
            enrichment_source: item.enrichmentSource,
            brand: item.brand,
            product_category: item.category,
            quality_score: item.qualityScore,
            needs_review: needsReview,
            quality_flags: item.qualityFlags,
          };
        }),
        tax_amount: parseTax(parsed.tax),
        receipt_total: Number.isFinite(receiptTotal) ? receiptTotal : null,
        computed_total: lineItemsTotal,
        totals_match: !totalMismatch,
        problematic_line_items: problematicLineItems,
        file_path: filePath,
        store,
      },
      meta: {
        user_id: user.id,
        line_item_count: lineItems.length,
        receipt_needs_review: totalMismatch || problematicLineItems.length > 0,
      },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    console.error("analyze-receipt error", {
      status: httpError.status,
      message: httpError.message,
      details: httpError.details,
    });

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
      if (/(chicken|beef|milk|grocery|produce|fruit|vegetable|snack)/i.test(lowered) && /inventory|cogs|food|grocery/i.test(category)) score += 0.7;
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

  const response = await fetch("https://api.openai.com/v1/responses", {
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
  });

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

function detectStoreType(...candidates: unknown[]): "sams_club" | "walmart" | "generic" {
  const combined = candidates.map((value) => String(value ?? "").toLowerCase()).join(" ");
  if (combined.includes("sam") || combined.includes("sams club")) return "sams_club";
  if (combined.includes("walmart")) return "walmart";
  return "generic";
}

async function requestReceiptExtraction(asset: Awaited<ReturnType<typeof prepareReceiptAsset>>) {
  const response = await fetch("https://api.openai.com/v1/responses", {
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
          content: buildOcrInput(asset),
        },
      ],
      max_output_tokens: 1200,
    }),
  });

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

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}
