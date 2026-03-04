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
  parseReceiptLines,
  requestTabscannerIngestion,
  resolveProductNames,
  validateReceiptMath,
} from "../_shared/receipt-pipeline.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") ?? undefined;
const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? undefined;
const PIPELINE_VERSION = 3;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);
    const filePath = normalizeIncomingFilePath(body.filePath);
    const forceReanalyze = body.forceReanalyze === true;
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await assertReceiptBelongsToUser(adminClient, user.id, filePath);

    if (!forceReanalyze) {
      const cached = await readCachedAnalysis(adminClient, user.id, filePath);
      if (cached) {
        return jsonResponse({ success: true, data: cached, meta: { source: "stored", pipeline_version: PIPELINE_VERSION } });
      }
    }

    const categories = await loadCategories(adminClient, user.id, body.categories);
    const blob = await downloadReceiptBlob(adminClient, filePath);
    const mimeType = blob.type || "application/octet-stream";
    const filename = `receipt.${filePath.split(".").pop() || "jpg"}`;

    const ingested = await requestTabscannerIngestion({
      blob,
      filename,
      mimeType,
      apiKey: TABSCANNER_API_KEY,
    });

    const parsed = parseReceiptLines(ingested);
    const withNames = await resolveProductNames({ items: parsed.items, serpApiKey: SERPAPI_API_KEY });
    const withCategories = applyCategorySuggestions(withNames, categories);

    const receipt = {
      ...parsed,
      items: withCategories,
    };

    const validation = validateReceiptMath(receipt);
    const normalizedItems = receipt.items.map((item) => ({
      product_number: item.product_number,
      resolved_name: item.resolved_name,
      raw_description: item.raw_description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
      needs_review: item.needs_review || !validation.total_ok || !validation.subtotal_ok,
      suggested_category: item.suggested_category,
      discount_promotion: item.discount_promotion,
      tax_line: item.tax_line,
      parser_source: item.parser_source,
    }));

    const analysis = {
      receipt,
      line_items: normalizedItems,
      tax_amount: receipt.tax,
      receipt_total: receipt.total,
      computed_total: Number((receipt.subtotal ?? 0) + (receipt.tax ?? 0)).toFixed(2),
      totals_match: validation.total_ok && validation.subtotal_ok,
      validation,
      raw_ocr: {
        provider: "tabscanner",
        raw: ingested.raw,
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

async function assertReceiptBelongsToUser(adminClient: ReturnType<typeof createClient>, userId: string, filePath: string) {
  const { data, error } = await adminClient
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("receipt_url", filePath)
    .maybeSingle();

  if (error) throw new HttpError(500, "Unable to validate receipt ownership", { db_error: error.message });
  if (!data) throw new HttpError(403, "Receipt does not belong to authenticated user", { file_path: filePath });
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
