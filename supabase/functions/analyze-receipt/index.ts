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
  applyCategorySuggestions,
  normalizeIncomingFilePath,
  parseReceiptWithOpenAI,
  requestTabscannerIngestion,
  resolveProductNames,
  validateReceiptMath,
} from "../_shared/receipt-pipeline.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") ?? undefined;
const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? undefined;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? undefined;
const PIPELINE_VERSION = 4;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);
    const requestedFilePath = String(body.filePath ?? "");
    const filePath = normalizeIncomingFilePath(requestedFilePath);
    const forceReanalyze = body.forceReanalyze === true;
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await assertReceiptBelongsToUser(adminClient, user.id, requestedFilePath, filePath);

    if (!forceReanalyze) {
      const cached = await readCachedAnalysis(adminClient, user.id, filePath);
      if (cached) {
        console.log("PIPELINE_STAGE_CACHE_HIT", { user_id: user.id, file_path: filePath });
        return jsonResponse({ success: true, data: cached, meta: { source: "stored", pipeline_version: PIPELINE_VERSION } });
      }
    }

    const categories = await loadCategories(adminClient, user.id, body.categories);
    const blob = await downloadReceiptBlob(adminClient, filePath);
    const mimeType = blob.type || "application/octet-stream";
    const filename = `receipt.${filePath.split(".").pop() || "jpg"}`;

    console.log("PIPELINE_STAGE_1_OCR_START", { user_id: user.id, file_path: filePath });
    const ingested = await requestTabscannerIngestion({ blob, filename, mimeType, apiKey: TABSCANNER_API_KEY });
    console.log("PIPELINE_STAGE_1_OCR_DONE", { lines: ingested.raw_text_lines.length });

    console.log("PIPELINE_STAGE_2_OPENAI_PARSE_START", { user_id: user.id, file_path: filePath });
    const parsedItems = await parseReceiptWithOpenAI({
      ocrText: ingested.raw_text,
      apiKey: OPENAI_API_KEY,
    });
    if (!parsedItems.length) {
      return jsonResponse({
        success: true,
        data: { message: "Receipt analysis pipeline initializing", line_items: [] },
        meta: { source: "initializing", pipeline_version: PIPELINE_VERSION },
      });
    }
    console.log("PIPELINE_STAGE_2_OPENAI_PARSE_DONE", { parsed_items: parsedItems.length });

    console.log("PIPELINE_STAGE_3_NAME_RESOLUTION_START", { user_id: user.id, file_path: filePath });
    const withNames = await resolveProductNames({ items: parsedItems, serpApiKey: SERPAPI_API_KEY, openAiKey: OPENAI_API_KEY });
    const withCategories = applyCategorySuggestions(withNames, categories);
    console.log("PIPELINE_STAGE_3_NAME_RESOLUTION_DONE", { resolved_items: withCategories.length });

    console.log("PIPELINE_STAGE_4_VALIDATION_START", { user_id: user.id, file_path: filePath });
    const validation = validateReceiptMath({
      items: withCategories,
      subtotalHint: ingested.subtotal_hint,
      taxHint: ingested.tax_hint,
      totalHint: ingested.total_hint,
    });
    console.log("PIPELINE_STAGE_4_VALIDATION_DONE", validation);

    const lineItems = withCategories.map((item) => ({
      product_number: item.product_number,
      product_name: item.product_name,
      raw_line_text: item.raw_line_text,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
      line_total: item.total_price,
      category_suggestion: item.category_suggestion,
      suggested_category: item.category_suggestion,
      discount_promotion: item.discount_promotion,
      needs_review: item.needs_review || !validation.total_ok || !validation.subtotal_ok,
    }));

    const analysis = {
      receipt: {
        store: ingested.store,
        date: ingested.date,
        subtotal: validation.subtotal,
        tax: validation.tax,
        total: validation.total,
      },
      line_items: lineItems,
      items: lineItems,
      tax_amount: validation.tax,
      receipt_total: validation.total,
      computed_total: validation.computed_total,
      totals_match: validation.total_ok && validation.subtotal_ok,
      validation,
      raw_ocr: {
        provider: "tabscanner",
        raw: ingested.raw,
        raw_text: ingested.raw_text,
        raw_text_lines: ingested.raw_text_lines,
        structured_blocks: ingested.structured_blocks,
      },
      pipeline_version: PIPELINE_VERSION,
      user_state: {},
    };

    await persistAnalysis(adminClient, user.id, filePath, analysis);

    return jsonResponse({
      success: true,
      data: analysis,
      meta: { source: "fresh", pipeline_version: PIPELINE_VERSION },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    console.error("PIPELINE_ERROR", {
      status: httpError.status,
      message: httpError.message,
      details: httpError.details ?? null,
    });

    return jsonResponse({
      success: false,
      error: {
        code: `ANALYZE_RECEIPT_${httpError.status}`,
        message: httpError.message,
        details: httpError.details ?? null,
      },
    }, httpError.status);
  }
});

async function requireAuthenticatedUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new HttpError(401, "Missing Authorization header");

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });

  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Invalid or expired JWT");
  return data.user;
}

async function assertReceiptBelongsToUser(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  requestedFilePath: string,
  normalizedFilePath: string,
) {
  const { data, error } = await adminClient
    .from("transactions")
    .select("id, receipt_url")
    .eq("user_id", userId)
    .not("receipt_url", "is", null)
    .limit(5000);

  if (error) throw new HttpError(500, "Unable to validate receipt ownership", { db_error: error.message });

  const ownsReceipt = (data ?? []).some((row: { receipt_url?: string | null }) => {
    const stored = String(row.receipt_url ?? "").trim();
    if (!stored) return false;
    if (stored === normalizedFilePath || stored === requestedFilePath) return true;
    try {
      return normalizeIncomingFilePath(stored) === normalizedFilePath;
    } catch {
      return false;
    }
  });

  if (!ownsReceipt) {
    throw new HttpError(403, "Receipt does not belong to authenticated user", { file_path: normalizedFilePath });
  }
}

async function readCachedAnalysis(adminClient: ReturnType<typeof createClient>, userId: string, filePath: string) {
  const { data, error } = await adminClient
    .from("receipt_analyses")
    .select("analysis_data, user_state")
    .eq("user_id", userId)
    .eq("file_path", filePath)
    .maybeSingle();

  if (error) {
    if (String(error.code) === "42P01" || String(error.message ?? "").includes("receipt_analyses")) return null;
    throw new HttpError(500, "Unable to read cached receipt analysis", { db_error: error.message });
  }

  if (!data?.analysis_data || typeof data.analysis_data !== "object") return null;
  return {
    ...(data.analysis_data as Record<string, unknown>),
    user_state: (data.user_state && typeof data.user_state === "object") ? data.user_state : {},
  };
}

async function persistAnalysis(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  filePath: string,
  analysis: Record<string, unknown>,
) {
  const { error } = await adminClient.from("receipt_analyses").upsert({
    user_id: userId,
    file_path: filePath,
    analysis_data: analysis,
    user_state: {},
    last_analyzed_at: new Date().toISOString(),
  }, { onConflict: "user_id,file_path" });

  if (error && String(error.code) !== "42P01") {
    throw new HttpError(500, "Unable to persist receipt analysis", { db_error: error.message });
  }
}

async function downloadReceiptBlob(adminClient: ReturnType<typeof createClient>, filePath: string): Promise<Blob> {
  const { data, error } = await adminClient.storage.from("receipts").download(filePath);
  if (error || !data) throw new HttpError(404, "Unable to download receipt file", { storage_error: error?.message ?? null });
  return data;
}

async function loadCategories(adminClient: ReturnType<typeof createClient>, userId: string, provided: unknown): Promise<string[]> {
  const fromBody = Array.isArray(provided) ? provided.map((v) => String(v ?? "").trim()).filter(Boolean) : [];
  if (fromBody.length) return dedupeCategories(fromBody);

  const { data } = await adminClient.from("categories").select("name").eq("user_id", userId);
  const names = (data ?? []).map((row: { name: string }) => row.name);
  return dedupeCategories(names);
}

function dedupeCategories(names: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const name of names) {
    const clean = name.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output;
}
