import { HttpError } from "./http.ts";
import { fetchWithTimeout } from "./fetch.ts";

const RECEIPTS_BUCKET = "receipts";
const STORAGE_MARKER = "/storage/v1/object/";

export type PipelineLineItem = {
  product_number: string | null;
  raw_line_text: string;
  quantity: number;
  unit_price: number | null;
  total_price: number;
  product_name: string;
  category_suggestion: string | null;
  discount_promotion: number;
  needs_review: boolean;
};

export type IngestedReceipt = {
  store: string | null;
  date: string | null;
  subtotal_hint: number | null;
  tax_hint: number | null;
  total_hint: number | null;
  raw: Record<string, unknown>;
  raw_text: string;
  raw_text_lines: string[];
  structured_blocks: Record<string, unknown>[];
};

export function normalizeIncomingFilePath(inputPath: unknown): string {
  const path = String(inputPath ?? "").trim();
  if (!path) throw new HttpError(400, "Missing filePath");

  let normalized = path;
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    const url = new URL(normalized);
    const markerIndex = url.pathname.indexOf(STORAGE_MARKER);
    if (markerIndex === -1) throw new HttpError(400, "filePath URL is not a Supabase storage URL");
    const storagePath = url.pathname.slice(markerIndex + STORAGE_MARKER.length);
    const segments = storagePath.split("/").filter(Boolean);
    if (segments.length < 3) throw new HttpError(400, "Invalid storage URL path");
    const [, bucket, ...objectParts] = segments;
    if (bucket !== RECEIPTS_BUCKET) throw new HttpError(400, `filePath must reference the ${RECEIPTS_BUCKET} bucket`);
    normalized = objectParts.join("/");
  }

  normalized = normalized.replace(/^\/+/, "");
  if (!normalized) throw new HttpError(400, "Invalid filePath");
  return normalized;
}

export async function requestTabscannerIngestion(params: {
  blob: Blob;
  filename: string;
  mimeType: string;
  apiKey?: string;
  timeoutMs?: number;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
}): Promise<IngestedReceipt> {
  const apiKey = params.apiKey?.trim();
  if (!apiKey) throw new HttpError(500, "TABSCANNER_API_KEY is required");

  const endpoint = Deno.env.get("TABSCANNER_API_URL") ?? "https://api.tabscanner.com";
  const timeoutMs = params.timeoutMs ?? 20000;
  const maxPollAttempts = params.maxPollAttempts ?? Number(Deno.env.get("TABSCANNER_MAX_POLL_ATTEMPTS") ?? 20);
  const pollIntervalMs = params.pollIntervalMs ?? Number(Deno.env.get("TABSCANNER_POLL_INTERVAL_MS") ?? 1200);

  const form = new FormData();
  form.append("file", new File([params.blob], params.filename, { type: params.mimeType }));

  const submit = await fetchWithTimeout(`${endpoint}/api/2/process`, {
    method: "POST",
    headers: { apikey: apiKey },
    body: form,
  }, timeoutMs);

  const submitPayload = await safeParseJsonResponse(submit);
  console.log("TABSCANNER_SUBMIT_RESPONSE", {
    endpoint: `${endpoint}/api/2/process`,
    status: submit.status,
    payload: sanitizeForLog(submitPayload),
  });
  if (!submit.ok) {
    throw new HttpError(502, "TabScanner submit failed", { status: submit.status, payload: submitPayload });
  }

  let payload = submitPayload;
  const token = extractTabscannerToken(submitPayload);

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    const normalized = normalizeTabscannerPayload(payload);
    if (normalized.raw_text.trim()) return normalized;
    if (!token) break;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const poll = await fetchWithTimeout(`${endpoint}/api/2/result/${token}`, {
      method: "GET",
      headers: { apikey: apiKey },
    }, timeoutMs);
    payload = await safeParseJsonResponse(poll);
    console.log("TABSCANNER_POLL_RESPONSE", {
      endpoint: `${endpoint}/api/2/result/${token}`,
      attempt: attempt + 1,
      status: poll.status,
      payload: sanitizeForLog(payload),
    });
  }

  const normalized = normalizeTabscannerPayload(payload);
  if (!normalized.raw_text.trim()) {
    throw new HttpError(422, "TabScanner returned no parsable receipt text", {
      has_token: Boolean(token),
      max_poll_attempts: maxPollAttempts,
      tabscanner_payload: sanitizeForLog(payload),
    });
  }

  return normalized;
}

export async function parseReceiptWithOpenAI(params: {
  ocrText: string;
  apiKey?: string;
}): Promise<Array<Pick<PipelineLineItem, "product_number" | "raw_line_text" | "quantity" | "unit_price" | "total_price" | "discount_promotion">>> {
  const apiKey = params.apiKey?.trim();
  if (!apiKey) throw new HttpError(500, "OPENAI_API_KEY is required");
  if (!params.ocrText.trim()) throw new HttpError(422, "OCR text is empty");

  const prompt = `Parse the receipt text into line items.\nDo not infer product names.\nKeep promotions/discounts as negative discount_promotion values.\nReturn strict JSON only.`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      line_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            product_number: { type: ["string", "null"] },
            raw_line_text: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: ["number", "null"] },
            total_price: { type: "number" },
            discount_promotion: { type: "number" },
          },
          required: ["product_number", "raw_line_text", "quantity", "unit_price", "total_price", "discount_promotion"],
        },
      },
    },
    required: ["line_items"],
  };

  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_RECEIPT_MODEL") ?? "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: params.ocrText.slice(0, 120000) }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "receipt_line_items",
          strict: true,
          schema,
        },
      },
    }),
  }, 30000);

  const payload = await safeParseJsonResponse(response);
  if (!response.ok) {
    throw new HttpError(502, "OpenAI structured parsing failed", { status: response.status, payload });
  }

  const parsed = extractResponseJson(payload);
  const items = Array.isArray(parsed?.line_items) ? parsed.line_items : [];
  if (!items.length) throw new HttpError(422, "OpenAI returned no line items");

  return items.map((item: Record<string, unknown>) => ({
    product_number: normalizeProductNumber(item.product_number),
    raw_line_text: String(item.raw_line_text ?? "").trim(),
    quantity: normalizeQuantity(item.quantity),
    unit_price: toMoneyOrNull(item.unit_price),
    total_price: toMoney(item.total_price),
    discount_promotion: toMoneyOrZero(item.discount_promotion),
  })).filter((item) => item.raw_line_text && Number.isFinite(item.total_price));
}

export async function resolveProductNames(params: {
  items: Array<Pick<PipelineLineItem, "product_number" | "raw_line_text" | "quantity" | "unit_price" | "total_price" | "discount_promotion">>;
  serpApiKey?: string;
  openAiKey?: string;
}): Promise<PipelineLineItem[]> {
  const serpCache = new Map<string, string | null>();

  return Promise.all(params.items.map(async (item) => {
    const number = normalizeProductNumber(item.product_number);
    let productName: string | null = null;

    if (number && params.serpApiKey) {
      if (!serpCache.has(number)) {
        serpCache.set(number, await fetchSerpProductTitle(number, params.serpApiKey));
      }
      productName = serpCache.get(number) ?? null;
    }

    if (!productName) {
      productName = await inferProductNameFromOpenAI(item.raw_line_text, params.openAiKey);
    }

    return {
      product_number: number,
      raw_line_text: item.raw_line_text,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
      discount_promotion: item.discount_promotion,
      product_name: productName || "Unknown Item",
      category_suggestion: null,
      needs_review: !productName,
    };
  }));
}

export function applyCategorySuggestions(items: PipelineLineItem[], categories: string[]): PipelineLineItem[] {
  return items.map((item) => {
    const suggestion = suggestCategory(item.product_name, categories);
    return { ...item, category_suggestion: suggestion ?? item.category_suggestion };
  });
}

export function validateReceiptMath(params: {
  items: PipelineLineItem[];
  subtotalHint: number | null;
  taxHint: number | null;
  totalHint: number | null;
}) {
  const subtotal = toMoney(params.items.reduce((sum, item) => sum + item.total_price + item.discount_promotion, 0));
  const tax = toMoneyOrZero(params.taxHint);
  const computedTotal = toMoney(subtotal + tax);
  const totalHint = Number.isFinite(params.totalHint) ? toMoney(params.totalHint as number) : null;

  const subtotalDelta = Number.isFinite(params.subtotalHint)
    ? toMoney((params.subtotalHint as number) - subtotal)
    : 0;
  const totalDelta = Number.isFinite(totalHint)
    ? toMoney((totalHint as number) - computedTotal)
    : 0;

  return {
    subtotal,
    tax,
    total: totalHint ?? computedTotal,
    computed_total: computedTotal,
    subtotal_ok: Math.abs(subtotalDelta) <= 0.05,
    total_ok: Math.abs(totalDelta) <= 0.05,
    delta_subtotal: subtotalDelta,
    delta_total: totalDelta,
  };
}

function normalizeTabscannerPayload(payload: unknown): IngestedReceipt {
  const source = (payload && typeof payload === "object") ? payload as Record<string, unknown> : {};
  const nodes = collectCandidateNodes([payload]);

  const structuredBlocks = nodes
    .flatMap((node) => [
      node.blocks,
      node.textBlocks,
      node.ocrBlocks,
      node.lines,
      node.raw_lines,
      node.ocr_lines,
      node.textLines,
      node.rawTextLines,
      node.documentLines,
      node.items,
      node.lineItems,
      node.products,
      node.entries,
      node.receiptItems,
    ])
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[];

  const joinedLines = nodes
    .flatMap((node) => [
      node.text,
      node.rawText,
      node.fullText,
      node.ocrText,
      node.documentText,
      node.raw_text,
      node.extractedText,
      node.recognizedText,
      node.content,
      node.receipt_text,
      node.description,
    ])
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;

  const rawTextLinesFromText = joinedLines
    ? joinedLines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  const rawTextLinesFromBlocks = structuredBlocks
    .flatMap((block) => [
      block.text,
      block.rawText,
      block.value,
      block.line,
      block.description,
      block.name,
      block.label,
      block.item,
    ])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  const rawTextLinesFromStringArrays = extractStringArrays(nodes);

  const rawTextLines = rawTextLinesFromText.length
    ? rawTextLinesFromText
    : (rawTextLinesFromBlocks.length
      ? rawTextLinesFromBlocks
      : (rawTextLinesFromStringArrays.length ? rawTextLinesFromStringArrays : extractLinesFromItemCandidates(nodes)));

  return {
    store: firstString(...nodes.map((node) => node.store ?? node.storeName ?? node.merchant)),
    date: firstString(...nodes.map((node) => node.date ?? node.purchaseDate)),
    subtotal_hint: firstFiniteMoney(...nodes.map((node) => node.subtotal ?? node.subTotal)),
    tax_hint: firstFiniteMoney(...nodes.map((node) => node.tax ?? node.totalTax)),
    total_hint: firstFiniteMoney(...nodes.map((node) => node.total ?? node.grandTotal)),
    raw: source,
    raw_text: rawTextLines.join("\n"),
    raw_text_lines: rawTextLines,
    structured_blocks: structuredBlocks,
  };
}

function extractLinesFromItemCandidates(nodes: Record<string, unknown>[]): string[] {
  const itemCandidates = nodes
    .flatMap((node) => [node.items, node.lineItems, node.products, node.entries, node.receiptItems])
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[];

  return itemCandidates
    .map((item) => {
      const text = String(item.text ?? item.rawText ?? item.description ?? item.name ?? item.label ?? "").trim();
      const amountRaw = item.total ?? item.amount ?? item.price ?? item.lineTotal;
      const amount = Number(String(amountRaw ?? "").replace(/[^\d.-]/g, ""));

      if (text && Number.isFinite(amount)) return `${text} ${amount.toFixed(2)}`;
      if (text) return text;
      if (Number.isFinite(amount)) return amount.toFixed(2);
      return "";
    })
    .filter(Boolean);
}

function collectCandidateNodes(seeds: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const queue = [...seeds];
  const seen = new Set<unknown>();

  while (queue.length) {
    const next = queue.shift();
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);

    if (Array.isArray(next)) {
      for (const item of next) queue.push(item);
      continue;
    }

    const record = next as Record<string, unknown>;
    out.push(record);
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }

  return out;
}

async function fetchSerpProductTitle(productNumber: string, apiKey?: string): Promise<string | null> {
  if (!apiKey) return null;
  const endpoint = new URL("https://serpapi.com/search.json");
  endpoint.searchParams.set("engine", "google");
  endpoint.searchParams.set("q", productNumber);
  endpoint.searchParams.set("api_key", apiKey);

  try {
    const response = await fetchWithTimeout(endpoint.toString(), { method: "GET" }, 10000);
    if (!response.ok) return null;
    const payload = await safeParseJsonResponse(response);
    const title = String(payload?.shopping_results?.[0]?.title ?? payload?.organic_results?.[0]?.title ?? "").trim();
    return title || null;
  } catch {
    return null;
  }
}

async function inferProductNameFromOpenAI(rawLineText: string, apiKey?: string): Promise<string | null> {
  if (!apiKey || !rawLineText.trim()) return null;

  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_RECEIPT_MODEL") ?? "gpt-4.1-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: `Return product name only for this receipt line: ${rawLineText}` }] }],
      max_output_tokens: 30,
    }),
  }, 15000);

  if (!response.ok) return null;
  const payload = await safeParseJsonResponse(response);
  const text = String(payload?.output_text ?? payload?.output?.[0]?.content?.[0]?.text ?? "").trim();
  return text || null;
}

function extractResponseJson(payload: any): any {
  const direct = payload?.output?.[0]?.content?.[0]?.text;
  const fallback = payload?.output_text;
  const raw = String(direct ?? fallback ?? "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeProductNumber(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const trimmed = digits.replace(/^0+/, "");
  return trimmed || "0";
}

function normalizeQuantity(raw: unknown): number {
  const quantity = Number(raw);
  if (!Number.isFinite(quantity) || quantity <= 0) return 1;
  return Number(quantity.toFixed(3));
}

function toMoney(raw: unknown): number {
  const parsed = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function toMoneyOrNull(raw: unknown): number | null {
  const parsed = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function toMoneyOrZero(raw: unknown): number {
  return Number.isFinite(Number(raw)) ? toMoney(raw) : 0;
}

function firstFiniteMoney(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = toMoneyOrNull(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return null;
}

function suggestCategory(name: string, categories: string[]): string | null {
  if (!categories.length) return null;
  const lowerName = name.toLowerCase();
  const scored = categories.map((category) => {
    const c = category.toLowerCase();
    let score = 0;
    const tokens = c.split(/\s+/).filter(Boolean);
    for (const token of tokens) if (lowerName.includes(token)) score += 1;
    if (lowerName.includes(c)) score += 2;
    return { category, score };
  }).sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));

  return scored[0]?.score ? scored[0].category : null;
}



function extractTabscannerToken(payload: unknown): string {
  const source = (payload && typeof payload === "object") ? payload as Record<string, unknown> : {};
  const candidates = [
    source.token,
    source.id,
    source.uuid,
    source.job_id,
    source.jobId,
    source.request_id,
    source.requestId,
    (source.data as Record<string, unknown> | undefined)?.token,
    (source.data as Record<string, unknown> | undefined)?.id,
    (source.result as Record<string, unknown> | undefined)?.token,
    (source.result as Record<string, unknown> | undefined)?.id,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }

  return "";
}

function extractStringArrays(nodes: Record<string, unknown>[]): string[] {
  const lines: string[] = [];

  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (!Array.isArray(value)) continue;
      if (!/text|line|ocr|content|description/i.test(key)) continue;

      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) {
          lines.push(entry.trim());
        }
      }
    }
  }

  return lines;
}

function sanitizeForLog(payload: unknown): unknown {
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized) return payload;
    if (serialized.length <= 4000) return JSON.parse(serialized);
    return {
      truncated: true,
      preview: serialized.slice(0, 4000),
      total_length: serialized.length,
    };
  } catch {
    return payload;
  }
}

async function safeParseJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
