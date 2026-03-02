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
  parseReceiptItems,
  parseTax,
  prepareReceiptAsset,
  safeParseJsonResponse,
} from "../_shared/receipt.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");
const OPENAI_API_KEY = getRequiredEnv("OPENAI_API_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);

    const filePath = normalizeIncomingFilePath(body.filePath);
    const categories = sanitizeCategories(body.categories);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await assertReceiptBelongsToUser(adminClient, user.id, filePath);

    const blob = await downloadReceiptBlob(adminClient, filePath);
    const receiptAsset = await prepareReceiptAsset(filePath, blob);

    const extractionPayload = await requestReceiptExtraction(receiptAsset);
    const parsed = extractJsonFromModelResponse(extractionPayload);

    if (!parsed) {
      throw new HttpError(422, "OCR did not return parseable JSON", {
        model_response_keys: Object.keys(extractionPayload ?? {}),
      });
    }

    const lineItems = parseReceiptItems(parsed.items);
    if (!lineItems.length) {
      throw new HttpError(422, "No valid line items detected", {
        item_count_from_model: Array.isArray(parsed.items) ? parsed.items.length : 0,
      });
    }

    return jsonResponse({
      success: true,
      data: {
        line_items: lineItems.map((item) => ({
          raw_description: item.name,
          normalized_description: item.name,
          amount: item.amount,
          suggested_category: suggestCategory(item.name, categories),
          product_code: item.code,
        })),
        tax_amount: parseTax(parsed.tax),
        file_path: filePath,
      },
      meta: {
        user_id: user.id,
        line_item_count: lineItems.length,
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

function sanitizeCategories(categories: unknown): string[] {
  if (!Array.isArray(categories)) return [];

  return categories
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .slice(0, 100);
}

function suggestCategory(itemName: string, categories: string[]): string {
  if (!categories.length) return "Needs Review";

  const loweredName = itemName.toLowerCase();
  const exact = categories.find((category) => loweredName.includes(category.toLowerCase()));
  return exact ?? "Needs Review";
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
