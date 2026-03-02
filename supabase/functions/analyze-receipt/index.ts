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
  blobToBase64,
  extractJsonFromModelResponse,
  normalizeIncomingFilePath,
  parseReceiptItems,
  parseTax,
} from "../_shared/receipt.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");
const OPENAI_API_KEY = getRequiredEnv("OPENAI_API_KEY");

type AnalyzeRequest = {
  filePath?: string;
  categories?: string[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = (await parseJsonBody(req)) as AnalyzeRequest;
    const filePath = normalizeIncomingFilePath(body.filePath);
    const categories = sanitizeCategories(body.categories);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const receiptBlob = await downloadReceiptBlob(adminClient, filePath);
    const modelPayload = await requestReceiptExtraction(await blobToBase64(receiptBlob));

    const parsed = extractJsonFromModelResponse(modelPayload);
    if (!parsed) {
      throw new HttpError(422, "OCR did not return parseable JSON", {
        model_response_keys: Object.keys(modelPayload ?? {}),
      });
    }

    const lineItems = parseReceiptItems(parsed.items);
    if (lineItems.length === 0) {
      throw new HttpError(422, "No valid line items detected", {
        item_count_from_model: Array.isArray(parsed.items) ? parsed.items.length : 0,
      });
    }

    const mappedItems = lineItems.map((item) => ({
      raw_description: item.name,
      normalized_description: item.name,
      amount: item.amount,
      suggested_category: suggestCategory(item.name, categories),
      product_code: item.code,
    }));

    return jsonResponse({
      success: true,
      data: {
        line_items: mappedItems,
        tax_amount: parseTax(parsed.tax),
        file_path: filePath,
      },
      meta: {
        user_id: user.id,
        line_item_count: mappedItems.length,
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

async function requestReceiptExtraction(base64Image: string) {
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
          content: [
            {
              type: "input_text",
              text:
                "Extract purchasable line items from this receipt image. Return JSON only with shape {\"items\":[{\"name\":string,\"amount\":number|string,\"code\":string|null}],\"tax\":number|string}. Do not include subtotal/total/payment lines as items.",
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${base64Image}`,
            },
          ],
        },
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new HttpError(502, "OpenAI OCR request failed", {
      status: response.status,
      openai_error: payload?.error?.message ?? null,
    });
  }

  return payload;
}
