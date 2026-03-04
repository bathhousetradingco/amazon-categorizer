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
const PIPELINE_VERSION = 5;

type AnalyzeRequest = {
  filePath: string;
  categories: string[];
  forceReanalyze: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);
    const parsedRequest = parseAnalyzeRequest(body);
    const requestedFilePath = parsedRequest.filePath;
    const filePath = normalizeIncomingFilePath(requestedFilePath);
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log("PIPELINE_STAGE_0_REQUEST", {
      user_id: user.id,
      requested_file_path: requestedFilePath,
      normalized_file_path: filePath,
      force_reanalyze: parsedRequest.forceReanalyze,
      category_count: parsedRequest.categories.length,
    });

    await assertReceiptBelongsToUser(adminClient, user.id, requestedFilePath, filePath);

    if (!parsedRequest.forceReanalyze) {
      const cached = await readCachedAnalysis(adminClient, user.id, filePath);
      if (cached) {
        console.log("PIPELINE_STAGE_CACHE_HIT", { user_id: user.id, file_path: filePath });
        return jsonResponse(toStableSuccess(cached, "stored"));
      }
    }

    const categories = await loadCategories(adminClient, user.id, parsedRequest.categories);
    const blob = await downloadReceiptBlob(adminClient, filePath);
    const mimeType = blob.type || "application/octet-stream";
    const filename = `receipt.${filePath.split(".").pop() || "jpg"}`;

    console.log("PIPELINE_STAGE_1_IMAGE_PATH_RECEIVED", {
      user_id: user.id,
      file_path: filePath,
      mime_type: mimeType,
      byte_size: blob.size,
    });

    let ingested;
    try {
      console.log("PIPELINE_STAGE_2_TABSCANNER_OCR_REQUEST", { user_id: user.id, file_path: filePath });
      ingested = await requestTabscannerIngestion({
        blob,
        filename,
        mimeType,
        apiKey: TABSCANNER_API_KEY,
      });
      console.log("PIPELINE_STAGE_3_TABSCANNER_OCR_RESPONSE", {
        user_id: user.id,
        file_path: filePath,
        raw_text_line_count: ingested.raw_text_lines.length,
      });
    } catch (error: unknown) {
      const ocrError = toHttpError(error);
      if (ocrError.status === 422) {
        console.warn("PIPELINE_STAGE_3_TABSCANNER_OCR_NO_TEXT", {
          user_id: user.id,
          file_path: filePath,
          details: ocrError.details ?? null,
        });
        return jsonResponse(toStableFailure("No text detected in receipt image"));
      }
      throw ocrError;
    }

    console.log("PIPELINE_STAGE_4_PARSED_RECEIPT_TEXT", {
      user_id: user.id,
      file_path: filePath,
      text_preview: ingested.raw_text.slice(0, 300),
      text_length: ingested.raw_text.length,
    });

    const parsedItems = await parseReceiptWithOpenAI({
      ocrText: ingested.raw_text,
      apiKey: OPENAI_API_KEY,
    });
    console.log("PIPELINE_STAGE_5_EXTRACTED_LINE_ITEMS", {
      user_id: user.id,
      file_path: filePath,
      line_item_count: parsedItems.length,
    });

    if (!parsedItems.length) {
      return jsonResponse(toStableFailure("No line items extracted from receipt text", ingested.raw_text));
    }

    const withNames = await resolveProductNames({ items: parsedItems, serpApiKey: SERPAPI_API_KEY, openAiKey: OPENAI_API_KEY });
    const withCategories = applyCategorySuggestions(withNames, categories);

    const validation = validateReceiptMath({
      items: withCategories,
      subtotalHint: ingested.subtotal_hint,
      taxHint: ingested.tax_hint,
      totalHint: ingested.total_hint,
    });

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

    const persisted = await persistAnalysis(adminClient, user.id, filePath, analysis);
    console.log("PIPELINE_STAGE_6_DATABASE_INSERT", {
      user_id: user.id,
      file_path: filePath,
      persisted,
    });

    const stable = toStableSuccess(analysis, "fresh");
    console.log("PIPELINE_STAGE_7_FINAL_RESPONSE", {
      user_id: user.id,
      file_path: filePath,
      success: stable.success,
      item_count: stable.items.length,
    });

    return jsonResponse(stable);
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    console.error("PIPELINE_ERROR", {
      status: httpError.status,
      message: httpError.message,
      details: httpError.details ?? null,
    });

    return jsonResponse({
      success: false,
      items: [],
      rawText: "",
      error: httpError.message,
      details: httpError.details ?? null,
    }, httpError.status);
  }
});

function parseAnalyzeRequest(body: Record<string, unknown>): AnalyzeRequest {
  const filePath = String(body.filePath ?? "").trim();
  if (!filePath) {
    throw new HttpError(400, "Missing required field: filePath", {
      expected_schema: {
        filePath: "string",
        categories: "string[]",
        forceReanalyze: "boolean",
      },
    });
  }

  let categories: string[] = [];
  if (typeof body.categories === "undefined") {
    categories = [];
  } else if (!Array.isArray(body.categories)) {
    throw new HttpError(400, "Invalid field: categories must be an array of strings");
  } else {
    const invalid = body.categories.find((value) => typeof value !== "string");
    if (typeof invalid !== "undefined") {
      throw new HttpError(400, "Invalid field: categories must contain only strings");
    }
    categories = body.categories.map((value) => String(value).trim()).filter(Boolean);
  }

  if (typeof body.forceReanalyze !== "undefined" && typeof body.forceReanalyze !== "boolean") {
    throw new HttpError(400, "Invalid field: forceReanalyze must be a boolean");
  }

  return {
    filePath,
    categories,
    forceReanalyze: body.forceReanalyze === true,
  };
}

function toStableSuccess(analysis: Record<string, unknown>, source: "stored" | "fresh") {
  const itemsRaw = analysis.items ?? analysis.line_items;
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const rawText = String((analysis.raw_ocr as Record<string, unknown> | undefined)?.raw_text ?? "");

  return {
    success: true,
    items,
    rawText,
    error: null,
    data: analysis,
    meta: { source, pipeline_version: PIPELINE_VERSION },
  };
}

function toStableFailure(message: string, rawText = "") {
  return {
    success: false,
    items: [],
    rawText,
    error: message,
  };
}

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
): Promise<boolean> {
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

  return !error;
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
