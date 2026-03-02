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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);
    const filePath = normalizeIncomingFilePath(body.filePath);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const receiptBlob = await downloadReceiptBlob(adminClient, filePath);
    const extraction = await requestExtraction(await blobToBase64(receiptBlob));
    const parsed = extractJsonFromModelResponse(extraction);

    if (!parsed) {
      throw new HttpError(422, "OCR did not return parseable JSON");
    }

    return jsonResponse({
      success: true,
      data: {
        items: parseReceiptItems(parsed.items),
        tax: parseTax(parsed.tax),
      },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    return jsonResponse(
      {
        success: false,
        error: {
          code: `PARSE_RECEIPT_${httpError.status}`,
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

  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(401, "Invalid or expired JWT", error ? { auth_error: error.message } : undefined);
  }
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

async function requestExtraction(base64Image: string) {
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
                "Extract purchasable line items and tax from this receipt. Return JSON only with keys items[] and tax.",
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
