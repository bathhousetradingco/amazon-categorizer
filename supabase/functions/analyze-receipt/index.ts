import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/fetch.ts";
import { HttpError, corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") || "";

const ITEM_NUMBER_PATTERN = /^\s*(0\d{8,9})\b/;

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
    const extraction = await extractReceiptText(signedUrl);

    const lines = String(extraction.fullText || "")
      .split("\n")
      .map((line) => line.trimEnd());

    const matchingLines: string[] = [];
    const itemNumbers: string[] = [];

    for (const line of lines) {
      const match = line.match(ITEM_NUMBER_PATTERN);
      if (!match) continue;
      matchingLines.push(line);
      itemNumbers.push(match[1]);
    }

    const debug = {
      raw_receipt_text: extraction.fullText,
      total_lines_detected: lines.filter((line) => line.trim().length > 0).length,
      lines_matching_item_number_pattern: matchingLines,
      item_numbers_found: itemNumbers,
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

async function extractReceiptText(signedUrl: string): Promise<{ fullText: string }> {
  if (!TABSCANNER_API_KEY) {
    throw new HttpError(500, "TABSCANNER_API_KEY is not configured");
  }

  const payload = {
    document: { image_url: signedUrl },
    output: ["raw_text"],
  };

  const response = await fetchWithTimeout("https://api.tabscanner.com/api/2/process", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": TABSCANNER_API_KEY,
    },
    body: JSON.stringify(payload),
  }, 45000);

  const json = await safeJson(response);
  if (!response.ok) {
    throw new HttpError(422, "OCR request failed", {
      status: response.status,
      body: json,
    });
  }

  const text = extractRawText(json);
  return { fullText: text };
}

async function safeJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractRawText(payload: any): string {
  const candidates = [
    payload?.result?.raw_text,
    payload?.raw_text,
    payload?.data?.raw_text,
    payload?.result?.text,
    payload?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}
