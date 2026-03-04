import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/fetch.ts";
import { HttpError, corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

const ITEM_NUMBER_LINE_PATTERN = /^0\d{9}\b/;

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
    const receiptPath = payloadReceiptUrl
      ? normalizeReceiptPath(payloadReceiptUrl)
      : await getUserReceiptPath(serviceClient, transactionId, user.id);

    const signedUrl = await createReceiptSignedUrl(serviceClient, receiptPath);
    const extraction = await extractReceiptData(signedUrl);

    const lines = String(extraction.fullText || "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    const regexItemNumbers = extractItemNumbersFromLines(lines);
    const itemNumbers = dedupeItemNumbers([
      ...regexItemNumbers,
      ...extraction.modelItemNumbers,
    ]);

    const matchingLines = lines.filter((line) => hasItemNumber(line));

    const debug = {
      provider: extraction.provider,
      raw_receipt_text: extraction.fullText,
      total_lines_detected: lines.length,
      lines_matching_item_number_pattern: matchingLines,
      item_numbers_found: itemNumbers,
      model_item_numbers: extraction.modelItemNumbers,
    };

    return jsonResponse({
      success: true,
      item_numbers: itemNumbers,
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

async function getUserReceiptPath(
  serviceClient: any,
  transactionId: string,
  userId: string,
): Promise<string> {
  const { data, error }: { data: { receipt_url?: string | null } | null; error: any } = await serviceClient
    .from("transactions")
    .select("receipt_url")
    .eq("id", transactionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to load transaction", error);
  if (!data?.receipt_url) throw new HttpError(404, "No receipt attached");

  return data.receipt_url;
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

async function extractReceiptData(signedUrl: string): Promise<{ fullText: string; modelItemNumbers: string[]; provider: string }> {
  if (!OPENAI_API_KEY) {
    throw new HttpError(500, "OPENAI_API_KEY is not configured");
  }

  const prompt = [
    "You are extracting product/item numbers from a purchase receipt image.",
    "Return strict JSON with keys: raw_text (string) and item_numbers (array of strings).",
    "Rules for item_numbers:",
    "- Include only likely product/item numbers from line items.",
    "- Preserve leading zeroes.",
    "- Exclude prices, totals, ZIP codes, dates, times, phone numbers, or transaction/reference ids.",
    "- Prefer numeric codes that are 9 to 12 digits.",
    "- If none are found, return an empty array.",
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
          { type: "input_image", image_url: signedUrl },
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

  return {
    fullText: rawText,
    modelItemNumbers,
    provider: "openai:gpt-4.1-mini",
  };
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

function hasItemNumber(line: string): boolean {
  return ITEM_NUMBER_LINE_PATTERN.test(line);
}

function extractItemNumbersFromLines(lines: string[]): string[] {
  const found: string[] = [];

  for (const line of lines) {
    const number = line.match(ITEM_NUMBER_LINE_PATTERN)?.[0];
    if (number) found.push(number);
  }

  return dedupeItemNumbers(found);
}

function dedupeItemNumbers(values: unknown[]): string[] {
  const normalized = values
    .map((value) => String(value || "").replace(/\D/g, ""))
    .filter((value) => /^0\d{9}$/.test(value))
    .map((value) => value.slice(1));

  return [...new Set(normalized)];
}
