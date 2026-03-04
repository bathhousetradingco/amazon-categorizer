import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/fetch.ts";
import { HttpError, corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

type ParsedReceiptLine = {
  raw: string;
  productNumber: string | null;
  normalizedProductNumber: string | null;
  textName: string | null;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") || "";
const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const user = await requireUser(req);
    const body = await parseJsonBody(req);
    const transactionId = String(body.transaction_id || "").trim();

    if (!transactionId) {
      throw new HttpError(400, "Missing transaction_id");
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const receiptPath = await getUserReceiptPath(serviceClient, transactionId, user.id);
    const signedUrl = await createReceiptSignedUrl(serviceClient, receiptPath);

    const extraction = await extractReceiptTextAndLines(signedUrl);
    const parsedLines = parseReceiptLineItems(extraction.lines, extraction.fullText);

    const productNameCandidates = await resolveReceiptProductNames(serviceClient, parsedLines);
    const items = dedupeAndNormalizeNames(productNameCandidates);

    if (!items.length) {
      return jsonResponse({ success: false, message: "No receipt items detected" }, 200);
    }

    return jsonResponse({
      success: true,
      items,
      metadata: {
        parsed_line_count: parsedLines.length,
        source_line_count: extraction.lines.length,
      },
    });
  } catch (error) {
    const httpError = toHttpError(error);
    if (httpError.status >= 500) {
      console.error("analyze-receipt error", httpError);
    }

    if (httpError.status === 422 || httpError.status === 404) {
      return jsonResponse({ success: false, message: "No receipt items detected" }, 200);
    }

    return jsonResponse({ success: false, message: httpError.message || "No receipt items detected" }, httpError.status);
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
  if (!data?.receipt_url) throw new HttpError(404, "No receipt items detected");

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

async function extractReceiptTextAndLines(signedUrl: string): Promise<{ fullText: string; lines: string[] }> {
  if (!TABSCANNER_API_KEY) {
    throw new HttpError(500, "TABSCANNER_API_KEY is not configured");
  }

  const payload = {
    document: { image_url: signedUrl },
    output: ["raw_text", "items"],
  };

  const response = await fetchWithTimeout("https://api.tabscanner.com/api/2/process", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": TABSCANNER_API_KEY,
    },
    body: JSON.stringify(payload),
  }, 25000);

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(422, "No receipt items detected", json);
  }

  const fullText = extractRawTextFromTabscanner(json);
  const lines = extractCandidateLinesFromTabscanner(json, fullText);

  return { fullText, lines };
}

function extractRawTextFromTabscanner(payload: any): string {
  const payloadCandidates = collectPayloadCandidates(payload);
  const candidates = [
    ...payloadCandidates.flatMap((candidate) => [
      candidate?.result?.raw_text,
      candidate?.result?.text,
      candidate?.raw_text,
      candidate?.text,
      candidate?.data?.text,
      candidate?.result?.document?.text,
      candidate?.document?.text,
    ]),
  ].filter(Boolean);

  if (candidates.length) return String(candidates[0]);

  const nestedTexts: string[] = [];
  const scan = (node: any) => {
    if (!node) return;
    if (typeof node === "string" && /\S/.test(node)) nestedTexts.push(node);
    if (Array.isArray(node)) node.forEach(scan);
    if (typeof node === "object") Object.values(node).forEach(scan);
  };
  for (const candidate of payloadCandidates) {
    scan(candidate?.result?.items || candidate?.items || candidate?.result?.line_items || []);
  }

  return nestedTexts.join("\n");
}

function extractCandidateLinesFromTabscanner(payload: any, fallbackText: string): string[] {
  const payloadCandidates = collectPayloadCandidates(payload);
  const structuredItems = payloadCandidates.flatMap((candidate) => {
    return extractStructuredItems(candidate);
  });
  const linesFromItems: string[] = [];

  if (Array.isArray(structuredItems)) {
    for (const item of structuredItems) {
      const text = readLineItemText(item);
      if (typeof text === "string" && text.trim()) {
        const amount = readLineItemAmount(item);
        linesFromItems.push(amount ? `${text} ${amount}` : text);
      }
    }
  }

  if (linesFromItems.length) return linesFromItems;

  return String(fallbackText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractStructuredItems(candidate: any): any[] {
  const direct = [
    candidate?.result?.items,
    candidate?.items,
    candidate?.result?.line_items,
    candidate?.result?.document?.items,
    candidate?.document?.items,
    candidate?.result?.receipt?.items,
    candidate?.receipt?.items,
    candidate?.result?.products,
    candidate?.products,
    candidate?.result?.positions,
    candidate?.positions,
  ];

  for (const value of direct) {
    if (Array.isArray(value) && value.length) {
      return value;
    }
  }

  return [];
}

function readLineItemText(item: any): string {
  const text = [
    item?.description,
    item?.name,
    item?.text,
    item?.raw,
    item?.desc,
    item?.title,
    item?.product_name,
    item?.item,
    item?.label,
    item?.value,
    item?.details?.description,
    item?.details?.name,
  ].find((value) => typeof value === "string" && value.trim());

  if (typeof text === "string") return text;

  const sku = [item?.sku, item?.product_code, item?.upc, item?.ean]
    .find((value) => typeof value === "string" && value.trim());
  const product = [item?.product, item?.details?.product]
    .find((value) => typeof value === "string" && value.trim());

  if (sku && product) return `${sku} ${product}`;
  if (product) return product;

  return "";
}

function readLineItemAmount(item: any): string {
  const amount = [
    item?.price,
    item?.total,
    item?.amount,
    item?.value,
    item?.sum,
    item?.gross,
    item?.net,
    item?.details?.amount,
  ].find((value) => ["string", "number"].includes(typeof value));

  return amount == null ? "" : String(amount);
}

function collectPayloadCandidates(payload: any): any[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.result)) {
    return payload.result;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [payload];
}

function parseReceiptLineItems(sourceLines: string[], fullText: string): ParsedReceiptLine[] {
  const lines = sourceLines.length
    ? sourceLines
    : String(fullText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const parsed = lines
    .map((line) => parseSingleLine(line))
    .filter((line): line is ParsedReceiptLine => Boolean(line));

  return parsed;
}

function parseSingleLine(line: string): ParsedReceiptLine | null {
  const clean = line.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (isNonItemLine(clean)) return null;

  const skuPattern = /^(\d{6,14})\s+(.+?)(?:\s+\$?\d+[\.,]\d{2})?$/;
  const skuMatch = clean.match(skuPattern);
  if (skuMatch) {
    const productNumber = skuMatch[1];
    const normalized = normalizeProductNumber(productNumber);
    const textName = cleanupNameText(skuMatch[2]);

    return {
      raw: clean,
      productNumber,
      normalizedProductNumber: normalized,
      textName,
    };
  }

  const normalized = clean
    .replace(/^\d+\s*[xX@]\s*\$?\d+[\.,]\d{2}\s+/, "")
    .replace(/\s+\$?\d+[\.,]\d{2}\s*$/, "")
    .replace(/\s+\d+\s*[xX]\s*\$?\d+[\.,]\d{2}\s*$/, "")
    .trim();

  const fallbackName = cleanupNameText(normalized);
  if (!fallbackName || fallbackName.length < 2) return null;

  return {
    raw: clean,
    productNumber: null,
    normalizedProductNumber: null,
    textName: fallbackName,
  };
}

function isNonItemLine(line: string): boolean {
  const upper = line.toUpperCase();
  const blocked = [
    "SUBTOTAL",
    "TOTAL",
    "TAX",
    "CHANGE",
    "CASH",
    "DEBIT",
    "CREDIT",
    "AMOUNT DUE",
    "THANK YOU",
    "SAVINGS",
    "MEMBER",
    "DATE",
    "TIME",
    "INVOICE",
    "RECEIPT",
    "STORE",
    "TERMINAL",
    "AUTH",
  ];

  return blocked.some((token) => upper.includes(token));
}

function normalizeProductNumber(productNumber: string): string {
  const normalized = String(productNumber || "").replace(/^0+/, "");
  return normalized || "0";
}

function cleanupNameText(name: string): string {
  return name
    .replace(/\s{2,}/g, " ")
    .replace(/[^A-Za-z0-9\s&'\-\.\/#]/g, "")
    .trim();
}

async function resolveReceiptProductNames(
  serviceClient: any,
  lines: ParsedReceiptLine[],
): Promise<string[]> {
  const names: string[] = [];

  for (const line of lines) {
    if (line.normalizedProductNumber) {
      const cached = await readProductLookupCache(serviceClient, line.normalizedProductNumber);
      if (cached) {
        names.push(cached);
        continue;
      }

      const resolved = await lookupProductNameBySku(line.normalizedProductNumber);
      if (resolved) {
        names.push(resolved);
        await upsertProductLookupCache(serviceClient, line.normalizedProductNumber, resolved);
        continue;
      }
    }

    if (line.textName) {
      names.push(line.textName);
    }
  }

  return names;
}

async function readProductLookupCache(
  serviceClient: any,
  normalizedSku: string,
): Promise<string | null> {
  const { data, error }: { data: { clean_name?: string | null } | null; error: any } = await serviceClient
    .from("product_lookup_cache")
    .select("clean_name")
    .eq("normalized_sku", normalizedSku)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("product cache read error", error);
    return null;
  }

  return data?.clean_name || null;
}

async function upsertProductLookupCache(
  serviceClient: any,
  normalizedSku: string,
  cleanName: string,
): Promise<void> {
  const payload = {
    sku: normalizedSku,
    clean_name: cleanName,
    source: "serpapi",
    metadata: { normalized_sku: normalizedSku },
    last_checked_at: new Date().toISOString(),
  };

  const { error }: { error: any } = await serviceClient.from("product_lookup_cache").upsert(payload as any, {
    onConflict: "sku",
  });

  if (error) {
    console.warn("product cache upsert error", error);
  }
}

async function lookupProductNameBySku(normalizedSku: string): Promise<string | null> {
  if (!SERPAPI_KEY) return null;

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", `${normalizedSku} sams club`);
  url.searchParams.set("num", "3");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const response = await fetchWithTimeout(url, {}, 12000);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("serpapi lookup failed", json);
    return null;
  }

  const fromShopping = Array.isArray(json?.shopping_results)
    ? json.shopping_results.find((r: any) => r?.title)
    : null;

  const fromOrganic = Array.isArray(json?.organic_results)
    ? json.organic_results.find((r: any) => r?.title)
    : null;

  const title = fromShopping?.title || fromOrganic?.title || "";
  const cleanTitle = cleanupNameText(String(title));
  return cleanTitle || null;
}

function dedupeAndNormalizeNames(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of items) {
    const normalized = cleanupNameText(item).replace(/\s+/g, " ").trim();
    if (!normalized) continue;

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    output.push(normalized);
  }

  return output;
}
