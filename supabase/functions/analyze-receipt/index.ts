import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/fetch.ts";
import { HttpError, corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";
import { dedupeItemNumbers, extractItemNumbersFromLineItems, isLikelyLineItem } from "./line-item-parser.ts";
import { normalizeModelReceiptItems } from "./model-line-items.ts";
import { resolveProductNames } from "./product-name-resolver.ts";
import { parseReceiptByMerchant } from "./receipt-parser.ts";
import { parseReceiptInstantSavingsTotal, parseReceiptTotals } from "./receipt-totals.ts";
import { validateReceiptMathByMerchant } from "./receipt-validator.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const user = await requireUser(req);
    const body = await parseJsonBody(req);
    const transactionId = String(body.transaction_id || "").trim();
    const payloadReceiptUrl = String(body.receipt_url || body.receipt_path || "").trim();

    if (!transactionId) {
      throw new HttpError(400, "Missing transaction_id");
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const transactionContext = await getUserTransactionContext(serviceClient, transactionId, user.id);
    const receiptPath = payloadReceiptUrl
      ? normalizeReceiptPath(payloadReceiptUrl)
      : transactionContext.receipt_url;

    const signedUrl = await createReceiptSignedUrl(serviceClient, receiptPath);
    const extraction = await extractReceiptData(signedUrl, receiptPath);

    const lines = String(extraction.fullText || "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    const lineItemNumbers = extractItemNumbersFromLineItems(lines);
    const modelItemNumbers = filterModelItemNumbers(extraction.modelItemNumbers, lines);
    const modelParsedItems = extraction.modelParsedItems;
    const itemNumbers = dedupeItemNumbers([
      ...lineItemNumbers,
      ...modelItemNumbers,
      ...modelParsedItems.map((item) => item.product_number),
    ]);
    const parsedReceipt = parseReceiptByMerchant({
      lines,
      candidateItemNumbers: itemNumbers,
      transactionName: transactionContext.name,
      merchantName: transactionContext.merchant_name,
      modelParsedItems,
    });
    const resolvedProducts = await resolveProductNames(
      serviceClient,
      parsedReceipt.merchant,
      parsedReceipt.item_numbers,
      parsedReceipt.parsed_items,
    );

    const matchingLines = lines.filter((line) => isLikelyLineItem(line));
    const receiptTotals = parseReceiptTotals(extraction.fullText);
    const instantSavingsTotal = parseReceiptInstantSavingsTotal(extraction.fullText);
    const receiptMathValidation = validateReceiptMathByMerchant({
      merchant: parsedReceipt.merchant,
      parsedItems: parsedReceipt.parsed_items,
      receiptTotals,
      itemNumbers: parsedReceipt.item_numbers,
    });

    const debug = {
      merchant: parsedReceipt.merchant,
      provider: extraction.provider,
      total_lines_detected: lines.length,
      lines_matching_item_number_pattern: matchingLines,
      item_numbers_found: parsedReceipt.item_numbers,
      parsed_items: parsedReceipt.parsed_items,
      parser_debug: parsedReceipt.debug,
      resolved_products: resolvedProducts,
      model_item_numbers: extraction.modelItemNumbers,
      filtered_model_item_numbers: modelItemNumbers,
      model_parsed_item_count: modelParsedItems.length,
      receipt_math_validation: receiptMathValidation,
    };

    return jsonResponse({
      success: true,
      merchant: parsedReceipt.merchant,
      item_numbers: parsedReceipt.item_numbers,
      parsed_items: parsedReceipt.parsed_items,
      resolved_products: resolvedProducts,
      receipt_totals: receiptTotals,
      instant_savings_total: instantSavingsTotal,
      receipt_math_validation: receiptMathValidation,
      debug,
    });
  } catch (error) {
    const httpError = toHttpError(error);
    if (httpError.status >= 500) {
      console.error("analyze-receipt error", httpError);
    }

    return jsonResponse({
      success: false,
      message: httpError.message || "Unable to analyze receipt",
    }, httpError.status);
  }
});

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new HttpError(401, "Unauthorized");

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await authClient.auth.getUser();

  if (error || !user) throw new HttpError(401, "Unauthorized");
  return user;
}

function normalizeReceiptPath(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^\/+/, "");
  }

  try {
    const url = new URL(trimmed);
    const marker = "/storage/v1/object/public/receipts/";
    const idx = url.pathname.indexOf(marker);

    if (idx !== -1) {
      return decodeURIComponent(url.pathname.slice(idx + marker.length)).replace(/^\/+/, "");
    }

    return decodeURIComponent(url.pathname.split("/").pop() || "").replace(/^\/+/, "");
  } catch {
    return trimmed;
  }
}

async function getUserTransactionContext(
  serviceClient: any,
  transactionId: string,
  userId: string,
): Promise<{ receipt_url: string; name?: string | null; merchant_name?: string | null }> {
  const { data, error }: {
    data: { receipt_url?: string | null; name?: string | null; merchant_name?: string | null } | null;
    error: any;
  } = await serviceClient
    .from("transactions")
    .select("receipt_url, name, merchant_name")
    .eq("id", transactionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to load transaction", error);
  if (!data?.receipt_url) throw new HttpError(404, "No receipt attached");

  return {
    receipt_url: data.receipt_url,
    name: data.name ?? null,
    merchant_name: data.merchant_name ?? null,
  };
}

async function createReceiptSignedUrl(
  serviceClient: any,
  receiptPath: string,
): Promise<string> {
  const { data, error } = await serviceClient.storage.from("receipts").createSignedUrl(receiptPath, 180);
  if (error || !data?.signedUrl) {
    throw new HttpError(500, "Failed to load receipt image", error);
  }
  return data.signedUrl;
}

async function extractReceiptData(
  signedUrl: string,
  receiptPath: string,
): Promise<{ fullText: string; modelItemNumbers: string[]; modelParsedItems: ReturnType<typeof normalizeModelReceiptItems>; provider: string }> {
  if (!OPENAI_API_KEY) {
    throw new HttpError(500, "OPENAI_API_KEY is not configured");
  }

  const prompt = [
    "You are extracting purchase receipt data from an image or PDF.",
    "Return strict JSON with keys: raw_text (string), item_numbers (array of strings), and line_items (array).",
    "Rules for item_numbers:",
    "- Include only likely product/item numbers from line items.",
    "- Include item numbers exactly as seen; normalization will happen downstream.",
    "- Exclude prices, totals, ZIP codes, dates, times, phone numbers, or transaction/reference ids.",
    "- Prefer numeric codes that are 9 to 12 digits.",
    "- If none are found, return an empty array.",
    "Rules for line_items:",
    "- Include actual purchased products/services only.",
    "- Exclude subtotal, tax, total, tender, payment, change, rewards, and loyalty rows.",
    "- Each line item should include description, product_number when visible, quantity, unit_price, total_price, and raw_text.",
    "- For Sam's Club and Walmart, preserve raw_text carefully; deterministic parsers will verify risky COGS receipts.",
    "- For miscellaneous receipts, line_items will be used as fallback split candidates.",
    "- If no line items are visible, return an empty array.",
  ].join("\n");

  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          await buildReceiptInputPart(signedUrl, receiptPath),
        ],
      }],
    }),
  }, 45000);

  const json = await safeJson(response);
  if (!response.ok) {
    throw new HttpError(422, "OCR request failed", {
      status: response.status,
      body: json,
    });
  }

  const responseText = extractResponseText(json);
  const parsed = parseJsonPayload(responseText);
  const rawText = typeof parsed?.raw_text === "string" && parsed.raw_text.trim()
    ? parsed.raw_text
    : responseText;
  const modelItemNumbers = dedupeItemNumbers(Array.isArray(parsed?.item_numbers) ? parsed.item_numbers : []);
  const modelParsedItems = normalizeModelReceiptItems(parsed?.line_items);

  return {
    fullText: rawText,
    modelItemNumbers,
    modelParsedItems,
    provider: "openai:gpt-4.1-mini",
  };
}

async function buildReceiptInputPart(signedUrl: string, receiptPath: string) {
  if (isPdfReceipt(receiptPath)) {
    const fileData = await fetchReceiptAsDataUrl(signedUrl, receiptPath);
    return {
      type: "input_file",
      filename: extractFilename(receiptPath) || "receipt.pdf",
      file_data: fileData,
    };
  }

  return { type: "input_image", image_url: signedUrl };
}

function isPdfReceipt(receiptPath: string): boolean {
  return /\.pdf(?:$|[?#])/i.test(String(receiptPath || "").trim());
}

function extractFilename(path: string): string {
  const normalized = String(path || "").trim().replace(/^\/+/, "");
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

async function fetchReceiptAsDataUrl(signedUrl: string, receiptPath: string): Promise<string> {
  const response = await fetchWithTimeout(signedUrl, {}, 30000);
  if (!response.ok) {
    throw new HttpError(500, "Failed to load PDF receipt for OCR", {
      status: response.status,
    });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const mimeType = isPdfReceipt(receiptPath) ? "application/pdf" : "application/octet-stream";
  return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractResponseText(payload: any): string {
  if (!payload || typeof payload !== "object") return "";

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const outputBlocks = Array.isArray(payload.output) ? payload.output : [];
  for (const block of outputBlocks) {
    const content = Array.isArray(block?.content) ? block.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }

  return "";
}

function parseJsonPayload(text: string): Record<string, unknown> | null {
  const candidate = String(text || "").trim();
  if (!candidate) return null;

  const direct = tryParseJson(candidate);
  if (direct) return direct;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  return tryParseJson(candidate.slice(start, end + 1));
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function filterModelItemNumbers(values: string[], lines: string[]): string[] {
  const likelyItemNumbers = new Set(extractItemNumbersFromLineItems(lines));

  return dedupeItemNumbers(values).filter((value) => likelyItemNumbers.has(value));
}
