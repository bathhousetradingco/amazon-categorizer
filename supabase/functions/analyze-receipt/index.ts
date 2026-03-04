import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/fetch.ts";
import { HttpError, corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

type ParsedReceiptLine = {
  raw: string;
  rawItemNumber: string | null;
  cleanedItemNumber: string | null;
  receiptText: string | null;
  quantity: number | null;
  unitPrice: number | null;
};

type ReceiptItem = {
  itemNumber?: string;
  name: string;
  price: number | null;
  qty: number;
};

type ItemResolutionDebug = {
  originalReceiptText: string;
  rawItemNumber: string | null;
  cleanedItemNumber: string | null;
  serpQuery: string | null;
  serpResponse: any;
  resolvedName: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") || "";
const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY") || "";
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

    const debug: Record<string, unknown> = {
      stage: "load_receipt",
      transaction_id: transactionId,
      request_receipt_url: payloadReceiptUrl || null,
    };

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const receiptPath = payloadReceiptUrl
      ? normalizeReceiptPath(payloadReceiptUrl)
      : await getUserReceiptPath(serviceClient, transactionId, user.id);

    debug.receipt_path = receiptPath;

    const signedUrl = await createReceiptSignedUrl(serviceClient, receiptPath);
    debug.signed_url_prefix = signedUrl.slice(0, 140);

    debug.stage = "download_receipt";
    const receiptDownload = await verifyReceiptDownload(signedUrl);
    debug.receipt_download = receiptDownload;

    debug.stage = "ocr";
    const extraction = await extractReceiptTextAndLines(signedUrl);
    debug.ocr = {
      full_text_length: extraction.fullText.length,
      line_count: extraction.lines.length,
      text_preview: extraction.fullText.slice(0, 500),
    };

    debug.stage = "openai_parse";
    const openAiParsedItems = await parseReceiptItemsWithOpenAI(extraction.fullText, extraction.lines, signedUrl);
    debug.openai = {
      items_count: openAiParsedItems.items.length,
      raw_preview: openAiParsedItems.rawResponse.slice(0, 500),
      parse_error: openAiParsedItems.parseError,
    };

    const parsedLines = parseReceiptLineItems(extraction.lines, extraction.fullText);
    debug.parsed_line_count = parsedLines.length;
    debug.parsed_lines_preview = parsedLines.slice(0, 12);

    const productNameCandidates = await resolveReceiptProductNames(serviceClient, parsedLines);
    const fallbackItems = dedupeAndNormalizeNames(productNameCandidates).map((name) => ({
      name,
      price: null,
      qty: 1,
    }));

    const parserItems = buildReceiptItemsFromParsedLines(parsedLines);
    const baseItems = parserItems.length
      ? parserItems
      : (openAiParsedItems.items.length ? openAiParsedItems.items : fallbackItems);
    debug.base_item_source = parserItems.length ? "state_machine_parser" : (openAiParsedItems.items.length ? "openai" : "fallback_names");
    const itemResolution = await applyResolvedNamesToItems(serviceClient, baseItems, parsedLines);
    const items = itemResolution.items;
    debug.item_resolution = itemResolution.debug;

    console.log("analyze-receipt pipeline", {
      transaction_id: transactionId,
      receipt_path: receiptPath,
      receipt_download: receiptDownload,
      ocr_line_count: extraction.lines.length,
      ocr_text_length: extraction.fullText.length,
      openai_items_count: openAiParsedItems.items.length,
      fallback_items_count: fallbackItems.length,
      final_items_count: items.length,
    });

    if (!items.length) {
      return jsonResponse({
        success: false,
        stage: inferFailureStage(debug),
        reason: "No receipt items detected",
        message: "No receipt items detected",
        debug,
      }, 200);
    }

    return jsonResponse({
      success: true,
      items,
      line_items: items.map((item) => item.name),
      metadata: {
        parsed_line_count: parsedLines.length,
        source_line_count: extraction.lines.length,
      },
      debug,
    });
  } catch (error) {
    const httpError = toHttpError(error);
    if (httpError.status >= 500) {
      console.error("analyze-receipt error", httpError);
    }

    if (httpError.status === 422 || httpError.status === 404) {
      return jsonResponse({
        success: false,
        stage: "OCR",
        reason: httpError.message || "No receipt items detected",
        message: "No receipt items detected",
      }, 200);
    }

    return jsonResponse({
      success: false,
      stage: "server",
      reason: httpError.message || "No receipt items detected",
      message: httpError.message || "No receipt items detected",
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

async function verifyReceiptDownload(signedUrl: string): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(signedUrl, {}, 12000);
  if (!response.ok) {
    throw new HttpError(422, "Failed to download receipt image", {
      status: response.status,
      statusText: response.statusText,
    });
  }

  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) {
    throw new HttpError(422, "Receipt image downloaded but is empty");
  }

  return {
    status: response.status,
    content_type: response.headers.get("content-type"),
    byte_length: bytes.byteLength,
  };
}

async function extractReceiptTextAndLines(signedUrl: string): Promise<{ fullText: string; lines: string[] }> {
  if (!TABSCANNER_API_KEY) {
    console.warn("tabscanner disabled: TABSCANNER_API_KEY is not configured");
    return { fullText: "", lines: [] };
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
      apikey: TABSCANNER_API_KEY,
    },
    body: JSON.stringify(payload),
  }, 25000);

  const json = await response.json().catch(() => ({}));
  const tabscannerApiError = extractTabscannerApiError(json);
  if (!response.ok) {
    throw new HttpError(422, "No receipt items detected", json);
  }

  if (isTabscannerParserError(json)) {
    console.warn("tabscanner parser error, continuing with OpenAI image fallback", {
      status: response.status,
      body: json,
    });
    return { fullText: "", lines: [] };
  }

  if (tabscannerApiError) {
    throw new HttpError(500, `Tabscanner authentication failed: ${tabscannerApiError}`, {
      status: response.status,
      body: json,
    });
  }

  const fullText = extractRawTextFromTabscanner(json);
  const lines = extractCandidateLinesFromTabscanner(json, fullText);

  console.group("RAW OCR TEXT");
  console.log(fullText);
  console.groupEnd();

  console.log("tabscanner response", {
    status: response.status,
    top_level_keys: Object.keys(json || {}),
    full_text_length: fullText.length,
    line_count: lines.length,
    lines_preview: lines.slice(0, 10),
  });

  return { fullText, lines };
}

function extractTabscannerApiError(payload: any): string | null {
  const messageCandidates = [
    payload?.error,
    payload?.message,
    payload?.detail,
    payload?.result?.error,
    payload?.result?.message,
    payload?.result?.detail,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => String(value).trim())
    .filter(Boolean);

  const authError = messageCandidates.find((value) =>
    /api key not found|invalid api key|unauthorized|forbidden|auth/i.test(value)
  );

  return authError || null;
}

async function parseReceiptItemsWithOpenAI(fullText: string, lines: string[], signedUrl: string): Promise<{
  items: ReceiptItem[];
  rawResponse: string;
  parseError: string | null;
}> {
  if (!OPENAI_API_KEY) {
    return { items: [], rawResponse: "", parseError: "OPENAI_API_KEY is not configured" };
  }

  const trimmedText = String(fullText || "").trim();
  if (!trimmedText && !lines.length && !signedUrl) {
    return { items: [], rawResponse: "", parseError: "No OCR text or image to parse" };
  }

  const prompt = `Extract receipt line items and return STRICT JSON only using this schema:
{
  "items": [
    { "name": "", "price": 0, "qty": 1 }
  ]
}

Rules:
- Include only purchased line items (no subtotal, tax, total, payment, store info).
- Keep item names concise.
- qty must be a number >= 1 (default 1).
- price must be numeric if visible, otherwise null.
- If no items are found, return {"items":[]}.

You may use OCR_TEXT and/or the receipt image to identify items.

OCR_TEXT:
${trimmedText || lines.join("\n")}`;

  const inputContent: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  if (signedUrl) {
    inputContent.push({ type: "input_image", image_url: signedUrl });
  }

  const openaiRes = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [{ role: "user", content: inputContent }],
      text: {
        format: {
          type: "json_schema",
          name: "receipt_items",
          schema: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    price: { type: ["number", "null"] },
                    qty: { type: "number" },
                  },
                  required: ["name", "price", "qty"],
                  additionalProperties: false,
                },
              },
            },
            required: ["items"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    }),
  }, 25000);

  const json = await openaiRes.json().catch(() => ({}));
  if (!openaiRes.ok) {
    console.warn("openai receipt parsing failed", json);
    return {
      items: [],
      rawResponse: JSON.stringify(json || {}),
      parseError: json?.error?.message || "OpenAI failed",
    };
  }

  const rawText = String(json?.output?.[0]?.content?.[0]?.text || "");
  const parsed = safeParseJson(rawText);
  const items = normalizeOpenAiItems(parsed?.items);

  return {
    items,
    rawResponse: rawText,
    parseError: parsed ? null : "Could not parse OpenAI JSON",
  };
}

function safeParseJson(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeOpenAiItems(input: unknown): ReceiptItem[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => {
      const name = cleanupNameText(String((item as any)?.name || ""));
      const qtyRaw = Number((item as any)?.qty);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      const priceRaw = (item as any)?.price;
      const numericPrice = typeof priceRaw === "number"
        ? priceRaw
        : typeof priceRaw === "string" && priceRaw.trim() !== ""
        ? Number(priceRaw)
        : null;
      const price = Number.isFinite(numericPrice as number) ? Number(numericPrice) : null;

      if (!name) return null;
      return { name, qty, price };
    })
    .filter((item): item is ReceiptItem => Boolean(item));
}

function inferFailureStage(debug: Record<string, unknown>): string {
  const ocr = debug.ocr as { full_text_length?: number; line_count?: number } | undefined;
  const openai = debug.openai as { items_count?: number } | undefined;

  if (!ocr?.full_text_length && !ocr?.line_count) return "OCR";
  if (!openai?.items_count) return "OpenAI";
  return String(debug.stage || "parse");
}

function extractRawTextFromTabscanner(payload: any): string {
  const payloadCandidates = collectPayloadCandidates(payload);
  const candidates = [
    ...payloadCandidates.flatMap((candidate) => [
      candidate?.result?.raw_text,
      candidate?.result?.text,
      candidate?.result?.ocr_text,
      candidate?.result?.full_text,
      candidate?.result?.ocr?.text,
      candidate?.result?.ocr?.raw_text,
      candidate?.result?.document?.raw_text,
      candidate?.raw_text,
      candidate?.text,
      candidate?.ocr_text,
      candidate?.full_text,
      candidate?.ocr?.text,
      candidate?.ocr?.raw_text,
      candidate?.data?.text,
      candidate?.result?.document?.text,
      candidate?.document?.text,
    ]),
  ].filter(Boolean);

  if (candidates.length) return String(candidates[0]);

  const discoveredText = findFirstDeepString(payloadCandidates, [
    "raw_text",
    "ocr_text",
    "full_text",
    "recognized_text",
    "plain_text",
    "text",
  ]);
  if (discoveredText) return discoveredText;

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
    candidate?.result?.products,
    candidate?.result?.entries,
    candidate?.result?.positions,
    candidate?.result?.lines,
    candidate?.result?.lineItems,
    candidate?.result?.line_items,
    candidate?.result?.ocr?.items,
    candidate?.result?.document?.line_items,
    candidate?.result?.document?.lines,
    candidate?.result?.receipt?.line_items,
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

  const deepItems = findFirstDeepArray(candidate, [
    "items",
    "line_items",
    "lineItems",
    "products",
    "positions",
    "lines",
    "entries",
  ]);
  if (deepItems.length) {
    return deepItems;
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

  if (payload?.result && typeof payload.result === "object") {
    return [payload.result];
  }

  if (typeof payload?.result === "string") {
    const parsed = safeParseJson(payload.result);
    if (parsed) return [parsed];
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [payload];
}

function isTabscannerParserError(payload: any): boolean {
  const messageCandidates = [
    payload?.error,
    payload?.message,
    payload?.detail,
    payload?.result?.error,
    payload?.result?.message,
    payload?.result?.detail,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => String(value).trim())
    .filter(Boolean);

  return messageCandidates.some((value) => /error\s*form\s*parser|errorformparser|form\s*parser/i.test(value));
}

function findFirstDeepString(root: any, keys: string[]): string | null {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  let fallback: string | null = null;

  const visit = (node: any) => {
    if (!node) return;
    if (typeof node === "string" && !fallback && /\S/.test(node)) {
      fallback = node;
      return;
    }

    if (Array.isArray(node)) {
      for (const value of node) {
        if (fallback) return;
        visit(value);
      }
      return;
    }

    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === "string" && keySet.has(key.toLowerCase()) && value.trim()) {
          fallback = value;
          return;
        }
      }

      for (const value of Object.values(node)) {
        if (fallback) return;
        visit(value);
      }
    }
  };

  visit(root);
  return fallback;
}

function findFirstDeepArray(root: any, keys: string[]): any[] {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  let result: any[] = [];

  const visit = (node: any) => {
    if (!node || result.length) return;

    if (Array.isArray(node)) {
      for (const value of node) {
        if (result.length) return;
        visit(value);
      }
      return;
    }

    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value) && value.length && keySet.has(key.toLowerCase())) {
          result = value;
          return;
        }
      }

      for (const value of Object.values(node)) {
        if (result.length) return;
        visit(value);
      }
    }
  };

  visit(root);
  return result;
}

function parseReceiptLineItems(sourceLines: string[], fullText: string): ParsedReceiptLine[] {
  const fallbackLines = String(fullText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lines = sourceLines.length
    ? sourceLines
    : String(fullText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const preferredLines = fallbackLines.length > lines.length ? fallbackLines : lines;

  console.group("PARSED LINES");
  preferredLines.forEach((line, index) => {
    console.log(index, line);
  });
  console.groupEnd();

  const parsed = parseSamsClubStateMachine(preferredLines);
  if (parsed.length) {
    return parsed;
  }

  return preferredLines
    .map((line) => parseSingleLine(line))
    .filter((line): line is ParsedReceiptLine => Boolean(line));
}

function parseSamsClubStateMachine(lines: string[]): ParsedReceiptLine[] {
  const parsed: ParsedReceiptLine[] = [];
  let pending: ParsedReceiptLine | null = null;

  for (const lineRaw of lines) {
    const line = String(lineRaw || "").replace(/\s+/g, " ").trim();
    if (!line || isNonItemLine(line)) continue;

    const skuPrefixMatch = line.match(/^(\d{8,12})\s+/);
    if (skuPrefixMatch) {
      if (pending) {
        parsed.push(pending);
        console.group("PARSED ITEM OBJECT");
        console.log(pending);
        console.groupEnd();
      }

      const rawItemNumber = skuPrefixMatch[1];
      const cleanedItemNumber = normalizeProductNumber(rawItemNumber);
      const receiptText = cleanupNameText(line.slice(skuPrefixMatch[0].length));

      console.log("Raw item number:", rawItemNumber);
      console.log("Cleaned item number:", cleanedItemNumber);

      pending = {
        raw: line,
        rawItemNumber,
        cleanedItemNumber,
        receiptText,
        quantity: null,
        unitPrice: null,
      };
      continue;
    }

    if (!pending) continue;
    const qtyPrice = parseQuantityAndPriceLine(line);
    if (qtyPrice) {
      pending.quantity = qtyPrice.quantity;
      pending.unitPrice = qtyPrice.unitPrice;
      pending.raw = `${pending.raw} || ${line}`;
      parsed.push(pending);
      console.group("PARSED ITEM OBJECT");
      console.log(pending);
      console.groupEnd();
      pending = null;
    }
  }

  if (pending) {
    parsed.push(pending);
    console.group("PARSED ITEM OBJECT");
    console.log(pending);
    console.groupEnd();
  }

  return parsed;
}

function parseQuantityAndPriceLine(line: string): { quantity: number | null; unitPrice: number | null } | null {
  const qtyMatch = line.match(/^(\d+)\s+AT\s+\d+\s+FOR\s+(\d+[\.,]\d{2})/i);
  if (qtyMatch) {
    return {
      quantity: Number(qtyMatch[1]),
      unitPrice: Number(qtyMatch[2].replace(",", ".")),
    };
  }

  const compactMatch = line.match(/^(\d+)\s*[xX@]\s*\$?(\d+[\.,]\d{2})/);
  if (compactMatch) {
    return {
      quantity: Number(compactMatch[1]),
      unitPrice: Number(compactMatch[2].replace(",", ".")),
    };
  }

  return null;
}

function parseSingleLine(line: string): ParsedReceiptLine | null {
  const clean = line.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (isNonItemLine(clean)) return null;

  const skuPattern = /^(\d{8,14})\s+(.+?)(?:\s+\$?\d+[\.,]\d{2})?$/;
  const skuMatch = clean.match(skuPattern);
  if (skuMatch) {
    const rawItemNumber = skuMatch[1];
    const cleanedItemNumber = normalizeProductNumber(rawItemNumber);
    const receiptText = cleanupNameText(skuMatch[2]);

    return {
      raw: clean,
      rawItemNumber,
      cleanedItemNumber,
      receiptText,
    };
  }

  const normalized = clean
    .replace(/^\d+\s*[xX@]\s*\$?\d+[\.,]\d{2}\s+/, "")
    .replace(/\s+\$?\d+[\.,]\d{2}\s*$/, "")
    .replace(/\s+\d+\s*[xX]\s*\$?\d+[\.,]\d{2}\s*$/, "")
    .trim();

  const receiptText = cleanupNameText(normalized);
  if (!receiptText || receiptText.length < 2) return null;

  return {
    raw: clean,
    rawItemNumber: null,
    cleanedItemNumber: null,
    receiptText,
    quantity: null,
    unitPrice: null,
  };
}

function buildReceiptItemsFromParsedLines(lines: ParsedReceiptLine[]): ReceiptItem[] {
  return lines
    .filter((line) => Boolean(line.cleanedItemNumber) && Boolean(line.receiptText))
    .map((line) => ({
      itemNumber: line.cleanedItemNumber || undefined,
      name: String(line.receiptText || "").trim(),
      price: typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice) ? line.unitPrice : null,
      qty: typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 1,
    }));
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
    "ERRORFORMPARSER",
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
  const productCache: Record<string, string | null> = {};

  for (const line of lines) {
    if (line.rawItemNumber || line.cleanedItemNumber) {
      const itemNumber = line.rawItemNumber || line.cleanedItemNumber || "";
      const resolved = await resolveSamsClubProductName(itemNumber, serviceClient, productCache);
      if (resolved) {
        names.push(resolved);
        continue;
      }
    }

    if (line.receiptText) {
      names.push(line.receiptText);
    }
  }

  return names;
}

async function resolveSamsClubProductName(
  itemNumber: string,
  serviceClient: any,
  productCache: Record<string, string | null>,
): Promise<string | null> {
  const result = await resolveSamsClubProductNameWithDebug(itemNumber, serviceClient, productCache);
  return result.resolvedName;
}

async function resolveSamsClubProductNameWithDebug(
  itemNumber: string,
  serviceClient: any,
  productCache: Record<string, string | null>,
): Promise<{ resolvedName: string | null; cleanedItemNumber: string; serpQuery: string; serpResponse: any }> {
  const normalizedSku = normalizeProductNumber(itemNumber);
  const serpQuery = `${normalizedSku} sams club`;

  if (!normalizedSku) {
    return { resolvedName: null, cleanedItemNumber: normalizedSku, serpQuery, serpResponse: null };
  }

  if (normalizedSku in productCache) {
    return { resolvedName: productCache[normalizedSku], cleanedItemNumber: normalizedSku, serpQuery, serpResponse: { cache: "memory" } };
  }

  const cached = await readProductLookupCache(serviceClient, normalizedSku);
  if (cached) {
    productCache[normalizedSku] = cached;
    return { resolvedName: cached, cleanedItemNumber: normalizedSku, serpQuery, serpResponse: { cache: "database" } };
  }

  const serpResult = await lookupProductNameBySku(normalizedSku);
  if (serpResult.name) {
    productCache[normalizedSku] = serpResult.name;
    return { resolvedName: serpResult.name, cleanedItemNumber: normalizedSku, serpQuery, serpResponse: serpResult.response };
  }

  productCache[normalizedSku] = null;
  return { resolvedName: null, cleanedItemNumber: normalizedSku, serpQuery, serpResponse: serpResult.response };
}

async function readProductLookupCache(
  serviceClient: any,
  normalizedSku: string,
): Promise<string | null> {
  const { data, error }: { data: { product_name?: string | null } | null; error: any } = await serviceClient
    .from("product_lookup")
    .select("product_name")
    .eq("item_number", normalizedSku)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("product cache read error", error);
    return null;
  }

  return data?.product_name || null;
}

async function lookupProductNameBySku(normalizedSku: string): Promise<{ name: string | null; response: any }> {
  if (!SERPAPI_KEY) return { name: null, response: { error: "Missing SERPAPI_KEY" } };

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", `${normalizedSku} sams club`);
  url.searchParams.set("num", "3");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const response = await fetchWithTimeout(url, {}, 12000);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("serpapi lookup failed", json);
    return { name: null, response: json };
  }

  const fromShopping = Array.isArray(json?.shopping_results)
    ? json.shopping_results.find((r: any) => r?.title)
    : null;

  const fromOrganic = Array.isArray(json?.organic_results)
    ? json.organic_results.find((r: any) => r?.title)
    : null;

  const title = fromShopping?.title || fromOrganic?.title || "";
  const cleanTitle = cleanupNameText(String(title));
  return { name: cleanTitle || null, response: json };
}


async function applyResolvedNamesToItems(
  serviceClient: any,
  items: ReceiptItem[],
  parsedLines: ParsedReceiptLine[],
): Promise<{ items: ReceiptItem[]; debug: ItemResolutionDebug[] }> {
  const productCache: Record<string, string | null> = {};
  const lineQueue = [...parsedLines];
  const debug: ItemResolutionDebug[] = [];
  const resolvedItems: ReceiptItem[] = [];

  for (const item of items) {
    const matchedLine = findBestParsedLineForItem(item, lineQueue);
    const rawItemNumber = item.itemNumber || matchedLine?.rawItemNumber || matchedLine?.cleanedItemNumber || "";
    const cleanedItemNumber = rawItemNumber ? normalizeProductNumber(rawItemNumber) : "";
    const originalName = String(matchedLine?.receiptText || item.name || "").trim();

    let serpQuery: string | null = null;
    let serpResponse: any = null;
    let resolvedName = originalName;

    if (cleanedItemNumber) {
      const resolution = await resolveSamsClubProductNameWithDebug(rawItemNumber, serviceClient, productCache);
      serpQuery = resolution.serpQuery;
      serpResponse = resolution.serpResponse;
      resolvedName = resolution.resolvedName || originalName;

      console.group("SERPAPI LOOKUP");
      console.log("Item number:", cleanedItemNumber);
      console.log("Query:", serpQuery);
      console.log("Response:", serpResponse);
      console.groupEnd();
    }

    resolvedItems.push({
      ...item,
      itemNumber: cleanedItemNumber || undefined,
      name: resolvedName,
    });

    debug.push({
      originalReceiptText: originalName,
      rawItemNumber: rawItemNumber || null,
      cleanedItemNumber: cleanedItemNumber || null,
      serpQuery,
      serpResponse,
      resolvedName,
    });
  }

  return { items: resolvedItems, debug };
}

function findBestParsedLineForItem(item: ReceiptItem, parsedLines: ParsedReceiptLine[]): ParsedReceiptLine | null {
  const itemNumber = normalizeProductNumber(item.itemNumber || "");
  if (itemNumber) {
    const byNumberIndex = parsedLines.findIndex((line) => normalizeProductNumber(line.rawItemNumber || line.cleanedItemNumber || "") === itemNumber);
    if (byNumberIndex >= 0) {
      const [line] = parsedLines.splice(byNumberIndex, 1);
      return line;
    }
  }

  const itemName = normalizeNameForMatch(item.name || "");
  const bestIndex = parsedLines.findIndex((line) => {
    if (!line.rawItemNumber) return false;
    const lineName = normalizeNameForMatch(line.receiptText || "");
    return lineName === itemName || lineName.includes(itemName) || itemName.includes(lineName);
  });

  if (bestIndex >= 0) {
    const [line] = parsedLines.splice(bestIndex, 1);
    return line;
  }

  const firstSkuIndex = parsedLines.findIndex((line) => line.rawItemNumber);
  if (firstSkuIndex >= 0) {
    const [line] = parsedLines.splice(firstSkuIndex, 1);
    return line;
  }

  return null;
}

function normalizeNameForMatch(name: string): string {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function extractProductNameFromJsonLd(html: string, normalizedSku: string): string | null {
  const scripts = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  if (!scripts.length) return null;

  const productNodes: any[] = [];
  for (const script of scripts) {
    const parsed = safeParseJson(script[1] || "");
    if (!parsed) continue;
    collectJsonLdProducts(parsed, productNodes);
  }

  if (!productNodes.length) return null;

  const normalizedMatch = productNodes.find((node) => {
    const sku = normalizeProductNumber(String(node?.sku || ""));
    return sku && sku === normalizedSku;
  });

  const candidate = normalizedMatch || productNodes.find((node) => node?.name);
  const cleanName = cleanupNameText(String(candidate?.name || ""));
  return cleanName || null;
}

function collectJsonLdProducts(node: any, output: any[]) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const entry of node) {
      collectJsonLdProducts(entry, output);
    }
    return;
  }

  if (typeof node !== "object") return;

  const typeField = node["@type"];
  const types = Array.isArray(typeField) ? typeField : [typeField];
  const isProduct = types.some((type) => typeof type === "string" && type.toLowerCase() === "product");

  if (isProduct && node?.name) {
    output.push(node);
  }

  if (node["@graph"]) {
    collectJsonLdProducts(node["@graph"], output);
  }
}

function extractSamsClubProductUrl(html: string): string | null {
  const hrefMatches = Array.from(html.matchAll(/href=["']([^"']+)["']/gi));

  for (const match of hrefMatches) {
    const href = match[1] || "";
    if (!/\/p\//i.test(href) || /\/s\//i.test(href)) continue;

    try {
      const url = new URL(href, "https://www.samsclub.com");
      if (!/samsclub\.com$/i.test(url.hostname)) continue;
      return url.toString();
    } catch {
      continue;
    }
  }

  return null;
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
