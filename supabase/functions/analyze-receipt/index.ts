import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HttpError, corsHeaders, getRequiredEnv, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

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

    const filePath = normalizeStoragePath(body.filePath);
    const categories = sanitizeCategories(body.categories);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const receiptBlob = await downloadReceiptBlob(adminClient, filePath);

    const base64 = await blobToBase64(receiptBlob);
    const ocrText = await openaiVisionOCR(base64);
    const parsedOCR = parseJsonFromText(ocrText);

    if (!parsedOCR || !Array.isArray(parsedOCR.items)) {
      throw new HttpError(422, "OCR did not return valid line item JSON");
    }

    const cleanedItems = parsedOCR.items
      .map((raw: any) => ({
        name: String(raw?.name || "").trim(),
        amount: Number(raw?.amount),
        code: raw?.code ? String(raw.code) : null,
      }))
      .filter((line) => isValidProductLine(line.name, line.amount));

    const taxAmount = Number(parsedOCR.tax || 0) || 0;

    const lineItems = await Promise.all(
      cleanedItems.map(async (item) => {
        const normalizedCode = normalizeCode(item.code);
        let normalizedName = "";

        if (normalizedCode) {
          const { data: memoryRow, error: memoryError } = await adminClient
            .from("product_match_memory")
            .select("product_name")
            .eq("product_code", normalizedCode)
            .maybeSingle();

          if (!memoryError && memoryRow?.product_name) {
            normalizedName = memoryRow.product_name;
          }
        }

        if (!normalizedName) {
          normalizedName = await cleanNameOneLine(item.name);
        }

        const suggestedCategory = categories.length
          ? await suggestCategory(normalizedName, categories)
          : "Needs Review";

        return {
          raw_description: item.name,
          normalized_description: normalizedName,
          amount: item.amount,
          suggested_category: suggestedCategory,
          product_code: normalizedCode,
        };
      }),
    );

    return jsonResponse({
      success: true,
      data: {
        line_items: lineItems,
        tax_amount: taxAmount,
        file_path: filePath,
      },
      meta: { user_id: user.id },
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
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 100);
}

function normalizeStoragePath(inputPath: unknown): string {
  const path = String(inputPath || "").trim();
  if (!path) throw new HttpError(400, "Missing filePath");

  let normalized = path;

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    const url = new URL(normalized);
    const marker = "/storage/v1/object/";
    const markerIndex = url.pathname.indexOf(marker);

    if (markerIndex !== -1) {
      const storagePath = url.pathname.slice(markerIndex + marker.length);
      const segments = storagePath.split("/").filter(Boolean);
      if (segments.length >= 3) {
        normalized = segments.slice(2).join("/");
      }
    }
  }

  normalized = normalized.replace(/^\/+/, "");

  if (normalized.startsWith("receipts/")) {
    normalized = normalized;
  }

  if (!normalized || normalized === "receipts") {
    throw new HttpError(400, "Invalid filePath");
  }

  return normalized;
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

function parseJsonFromText(text: string): any | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < 0 || first >= last) return null;

  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function isValidProductLine(name: string, amount: number): boolean {
  if (!name || !Number.isFinite(amount) || amount <= 0) return false;

  const blacklist = ["subtotal", "total", "tax", "discount", "coupon", "change"];
  const lower = name.toLowerCase();
  return !blacklist.some((token) => lower.includes(token));
}

function normalizeCode(code: string | null): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^0+/, "") || null;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function openaiVisionOCR(base64: string): Promise<string> {
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
              text: "Extract purchasable receipt line items. Return strict JSON with items[] and tax.",
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${base64}`,
            },
          ],
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new HttpError(502, "OpenAI OCR request failed", {
      openai_error: data?.error?.message ?? null,
      status: response.status,
    });
  }

  return data?.output?.[0]?.content?.[0]?.text || "";
}

async function cleanNameOneLine(name: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: `Clean this product name. Return only the product name: ${name}`,
    }),
  });

  const data = await response.json();
  if (!response.ok) return name;

  return data?.output?.[0]?.content?.[0]?.text?.trim() || name;
}

async function suggestCategory(name: string, categories: string[]): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: `Choose one category from this list: ${categories.join(", ")}\n\nItem: ${name}\n\nReturn only the category name.`,
    }),
  });

  const data = await response.json();
  if (!response.ok) return "Needs Review";

  const suggestion = data?.output?.[0]?.content?.[0]?.text?.trim() || "Needs Review";
  return categories.includes(suggestion) ? suggestion : "Needs Review";
}
