import { HttpError } from "./http.ts";
import { fetchWithTimeout } from "./fetch.ts";

const RECEIPTS_BUCKET = "receipts";
const STORAGE_MARKER = "/storage/v1/object/";

export type ReceiptItem = {
  product_number: string | null;
  resolved_name: string;
  raw_description: string;
  quantity: number;
  unit_price: number | null;
  line_total: number;
  discount_promotion: number;
  tax_line: number;
  needs_review: boolean;
  suggested_category: string | null;
  parser_source: "structured" | "text";
};

export type ParsedReceipt = {
  store: string | null;
  date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  items: ReceiptItem[];
};

export type IngestedReceipt = {
  store: string | null;
  date: string | null;
  raw: Record<string, unknown>;
  raw_text_lines: string[];
  structured_blocks: Record<string, unknown>[];
  structured_items: Array<{ description: string; amount: number | null; product_number: string | null }>;
  subtotal_hint: number | null;
  tax_hint: number | null;
  total_hint: number | null;
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
}): Promise<IngestedReceipt> {
  const apiKey = params.apiKey?.trim();
  if (!apiKey) throw new HttpError(500, "TABSCANNER_API_KEY is required");

  const endpoint = Deno.env.get("TABSCANNER_API_URL") ?? "https://api.tabscanner.com";
  const timeoutMs = params.timeoutMs ?? 15000;
  const form = new FormData();
  form.append("file", new File([params.blob], params.filename, { type: params.mimeType }));

  const submit = await fetchWithTimeout(`${endpoint}/api/2/process`, {
    method: "POST",
    headers: { apikey: apiKey },
    body: form,
  }, timeoutMs);

  const submitPayload = await safeParseJsonResponse(submit);
  if (!submit.ok) {
    throw new HttpError(502, "TabScanner submit failed", { status: submit.status, payload: submitPayload });
  }

  let payload = submitPayload;
  const token = String(submitPayload?.token ?? submitPayload?.id ?? submitPayload?.uuid ?? "").trim();

  for (let attempt = 0; attempt < 7; attempt++) {
    const normalized = normalizeTabscannerIngestionPayload(payload);
    if (normalized.raw_text_lines.length || normalized.structured_items.length) return normalized;
    if (!token) break;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const poll = await fetchWithTimeout(`${endpoint}/api/2/result/${token}`, {
      method: "GET",
      headers: { apikey: apiKey },
    }, timeoutMs);
    payload = await safeParseJsonResponse(poll);
    if (!poll.ok) continue;
  }

  const normalized = normalizeTabscannerIngestionPayload(payload);
  if (!normalized.raw_text_lines.length && !normalized.structured_items.length) {
    throw new HttpError(422, "TabScanner returned no parsable receipt text");
  }
  return normalized;
}

function normalizeTabscannerIngestionPayload(payload: any): IngestedReceipt {
  const source = (payload?.result ?? payload?.data ?? payload ?? {}) as Record<string, unknown>;
  const candidateNodes = collectCandidateNodes([payload, source]);

  const structuredBlocks = candidateNodes
    .flatMap((node) => [node.blocks, node.textBlocks, node.ocrBlocks])
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[];

  const rawText = candidateNodes
    .flatMap((node) => [node.text, node.rawText, node.fullText, node.ocrText, node.documentText])
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;

  const lineCandidates = candidateNodes
    .flatMap((node) => [node.lines, node.raw_lines, node.ocr_lines, node.textLines, node.rawTextLines, node.documentLines])
    .find((value) => Array.isArray(value));

  const rawTextLinesFromCandidates = rawText
    ? rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : toLineStrings(lineCandidates);

  const rawTextLines = rawTextLinesFromCandidates.length
    ? rawTextLinesFromCandidates
    : extractLinesFromStructuredBlocks(structuredBlocks);

  const rawItems = candidateNodes
    .flatMap((node) => [node.items, node.lineItems, node.products, node.entries, node.receiptItems])
    .find((value) => Array.isArray(value));

  const structuredItems = (Array.isArray(rawItems) ? rawItems : [])
    .map((entry: any) => normalizeStructuredItem(entry))
    .filter((entry) => entry.description);

  const subtotal_hint = firstFiniteMoney(...candidateNodes.map((node) => node.subtotal ?? node.subTotal));
  const tax_hint = firstFiniteMoney(...candidateNodes.map((node) => node.tax ?? node.totalTax));
  const total_hint = firstFiniteMoney(...candidateNodes.map((node) => node.total ?? node.grandTotal));

  return {
    store: firstString(...candidateNodes.map((node) => node.store ?? node.storeName ?? node.merchant)),
    date: firstString(...candidateNodes.map((node) => node.date ?? node.purchaseDate)),
    raw: source,
    raw_text_lines: rawTextLines,
    structured_blocks: structuredBlocks,
    structured_items: structuredItems,
    subtotal_hint,
    tax_hint,
    total_hint,
  };
}

function normalizeStructuredItem(entry: any): { description: string; amount: number | null; product_number: string | null } {
  const description = stringOrNull(
    entry?.name ?? entry?.description ?? entry?.title ?? entry?.text ?? entry?.label ?? entry?.item,
  ) ?? "";
  const amount = firstFiniteMoney(
    entry?.price,
    entry?.amount,
    entry?.total,
    entry?.lineTotal,
    entry?.value,
    entry?.line_amount,
  );
  const product_number = normalizeProductNumber(
    entry?.product_number ?? entry?.code ?? entry?.sku ?? entry?.barcode ?? entry?.id ?? entry?.gtin ?? entry?.upc,
  );
  return { description, amount, product_number };
}

function toLineStrings(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => {
      if (typeof line === "string") return line;
      if (line && typeof line === "object") {
        const node = line as Record<string, unknown>;
        return String(node.text ?? node.rawText ?? node.value ?? node.line ?? "");
      }
      return String(line ?? "");
    })
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractLinesFromStructuredBlocks(blocks: Record<string, unknown>[]): string[] {
  return blocks
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

export function parseReceiptLines(ingested: IngestedReceipt): ParsedReceipt {
  const fromStructured = ingested.structured_items.map((item) => parseStructuredItem(item));
  const fromText = parseTextLines(ingested.raw_text_lines);

  const deduped = dedupeItems([...fromStructured, ...fromText]);

  const saleItems = deduped.filter((item) => item.tax_line === 0 && item.line_total > 0);
  const discountTotal = deduped.reduce((sum, item) => sum + item.discount_promotion, 0);
  const explicitTax = deduped.reduce((sum, item) => sum + item.tax_line, 0);

  const subtotal = toMoney(saleItems.reduce((sum, item) => sum + item.line_total, 0) + discountTotal);
  const tax = firstFiniteMoney(explicitTax, ingested.tax_hint, 0);
  const total = toMoney(subtotal + (tax ?? 0));

  return {
    store: ingested.store,
    date: ingested.date,
    subtotal: firstFiniteMoney(ingested.subtotal_hint, subtotal),
    tax,
    total: firstFiniteMoney(ingested.total_hint, total),
    items: deduped,
  };
}

function parseStructuredItem(item: { description: string; amount: number | null; product_number: string | null }): ReceiptItem {
  const quantityParse = extractQuantityAndUnit(item.description, item.amount ?? undefined);
  const raw = item.description.trim();
  const isDiscount = isDiscountLine(raw);
  const isTax = isTaxLine(raw);
  const lineTotal = Number.isFinite(item.amount) ? toMoney(item.amount as number) : toMoney(quantityParse.lineTotal);

  return {
    product_number: item.product_number,
    resolved_name: raw,
    raw_description: raw,
    quantity: quantityParse.quantity,
    unit_price: quantityParse.unitPrice,
    line_total: lineTotal,
    discount_promotion: isDiscount ? -Math.abs(lineTotal) : 0,
    tax_line: isTax ? Math.abs(lineTotal) : 0,
    needs_review: false,
    suggested_category: null,
    parser_source: "structured",
  };
}

function parseTextLines(lines: string[]): ReceiptItem[] {
  const output: ReceiptItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = normalizeWhitespace(lines[i]);
    if (!current) continue;

    const currentMoney = parseTrailingMoney(current);
    const next = normalizeWhitespace(lines[i + 1] ?? "");
    const nextMoney = parseTrailingMoney(next);
    const shouldUseNextLinePrice = !Number.isFinite(currentMoney) && Number.isFinite(nextMoney) && !/\d{5,}/.test(next);

    const descriptor = shouldUseNextLinePrice ? current : stripTrailingMoney(current);
    const lineTotal = Number.isFinite(currentMoney) ? currentMoney : (shouldUseNextLinePrice ? (nextMoney as number) : NaN);
    const quantityParse = extractQuantityAndUnit(descriptor, Number.isFinite(lineTotal) ? lineTotal : undefined);

    if (shouldUseNextLinePrice) i += 1;

    if (!Number.isFinite(lineTotal) && !looksLikeItemDescriptor(descriptor)) continue;

    const cleanDescription = descriptor.trim();
    const product_number = extractProductNumber(cleanDescription);
    const isDiscount = isDiscountLine(cleanDescription);
    const isTax = isTaxLine(cleanDescription);

    if (isSubtotalOrTotal(cleanDescription) || /^\s*(cash|change|payment|visa|mastercard|debit|credit)\b/i.test(cleanDescription)) {
      continue;
    }

    output.push({
      product_number,
      resolved_name: cleanDescription,
      raw_description: cleanDescription,
      quantity: quantityParse.quantity,
      unit_price: quantityParse.unitPrice,
      line_total: Number.isFinite(lineTotal) ? toMoney(lineTotal) : toMoney(quantityParse.lineTotal),
      discount_promotion: isDiscount ? -Math.abs(Number.isFinite(lineTotal) ? lineTotal : quantityParse.lineTotal) : 0,
      tax_line: isTax ? Math.abs(Number.isFinite(lineTotal) ? lineTotal : quantityParse.lineTotal) : 0,
      needs_review: false,
      suggested_category: null,
      parser_source: "text",
    });
  }

  return output;
}

function dedupeItems(items: ReceiptItem[]): ReceiptItem[] {
  const seen = new Set<string>();
  const deduped: ReceiptItem[] = [];

  for (const item of items) {
    if (!item.raw_description || (!item.line_total && !item.tax_line && !item.discount_promotion)) continue;
    const key = [
      item.product_number ?? "none",
      item.raw_description.toLowerCase().replace(/\s+/g, " "),
      item.quantity,
      item.line_total.toFixed(2),
      item.tax_line.toFixed(2),
      item.discount_promotion.toFixed(2),
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function extractQuantityAndUnit(description: string, lineTotal?: number): { quantity: number; unitPrice: number | null; lineTotal: number } {
  const atMatch = description.match(/\b(\d{1,4})\s*@\s*(\d+(?:\.\d{1,2})?)\b/i);
  if (atMatch) {
    const quantity = Math.max(1, Number(atMatch[1]));
    const unit = toMoney(Number(atMatch[2]));
    const total = Number.isFinite(lineTotal) ? toMoney(lineTotal as number) : toMoney(quantity * unit);
    return { quantity, unitPrice: unit, lineTotal: total };
  }

  const qtyPrefix = description.match(/^\s*(\d{1,4})\s+(?:x\s+)?/i);
  if (qtyPrefix && Number(qtyPrefix[1]) > 1 && Number.isFinite(lineTotal)) {
    const quantity = Number(qtyPrefix[1]);
    return { quantity, unitPrice: toMoney((lineTotal as number) / quantity), lineTotal: toMoney(lineTotal as number) };
  }

  if (Number.isFinite(lineTotal)) {
    return { quantity: 1, unitPrice: toMoney(lineTotal as number), lineTotal: toMoney(lineTotal as number) };
  }

  return { quantity: 1, unitPrice: null, lineTotal: 0 };
}

export async function resolveProductNames(params: {
  items: ReceiptItem[];
  serpApiKey?: string;
}): Promise<ReceiptItem[]> {
  const cache = new Map<string, string | null>();

  return Promise.all(params.items.map(async (item) => {
    const cleanedNumber = normalizeProductNumber(item.product_number);
    let resolved = item.raw_description;

    if (cleanedNumber && params.serpApiKey) {
      if (!cache.has(cleanedNumber)) {
        cache.set(cleanedNumber, await fetchSerpProductTitle(cleanedNumber, params.serpApiKey));
      }
      resolved = cache.get(cleanedNumber) ?? item.raw_description;
    }

    return {
      ...item,
      product_number: cleanedNumber,
      resolved_name: resolved,
      needs_review: item.needs_review || !cleanedNumber || !resolved || resolved === item.raw_description,
    };
  }));
}

async function fetchSerpProductTitle(productNumber: string, apiKey: string): Promise<string | null> {
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

export function validateReceiptMath(parsed: ParsedReceipt): { subtotal_ok: boolean; total_ok: boolean; delta_subtotal: number; delta_total: number } {
  const itemSubtotal = toMoney(parsed.items.filter((item) => item.tax_line === 0).reduce((sum, item) => sum + item.line_total + item.discount_promotion, 0));
  const computedTotal = toMoney(itemSubtotal + (parsed.tax ?? 0));

  const deltaSubtotal = Number.isFinite(parsed.subtotal) ? toMoney((parsed.subtotal as number) - itemSubtotal) : 0;
  const deltaTotal = Number.isFinite(parsed.total) ? toMoney((parsed.total as number) - computedTotal) : 0;

  return {
    subtotal_ok: Math.abs(deltaSubtotal) <= 0.05,
    total_ok: Math.abs(deltaTotal) <= 0.05,
    delta_subtotal: deltaSubtotal,
    delta_total: deltaTotal,
  };
}

export function applyCategorySuggestions(items: ReceiptItem[], categories: string[]): ReceiptItem[] {
  return items.map((item) => {
    if (!item.needs_review) return item;
    const suggestion = suggestCategory(item.resolved_name, categories);
    return { ...item, suggested_category: suggestion };
  });
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

  return scored[0]?.category ?? null;
}

function extractProductNumber(line: string): string | null {
  const matches = line.match(/\b\d{6,14}\b/g) ?? [];
  if (!matches.length) return null;
  return normalizeProductNumber(matches[0]);
}

function normalizeProductNumber(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits || digits.length < 6 || digits.length > 14) return null;
  return digits.replace(/^0+/, "") || "0";
}

function isDiscountLine(line: string): boolean {
  return /\b(discount|coupon|promo|promotion|inst\s*sv|savings?)\b/i.test(line);
}

function isTaxLine(line: string): boolean {
  return /\b(tax|vat)\b/i.test(line);
}

function isSubtotalOrTotal(line: string): boolean {
  return /\b(sub\s*total|total)\b/i.test(line);
}

function looksLikeItemDescriptor(line: string): boolean {
  if (!line) return false;
  if (isSubtotalOrTotal(line) || isTaxLine(line)) return false;
  return /[a-zA-Z]/.test(line) || /\b\d{6,14}\b/.test(line);
}

function parseTrailingMoney(line: string): number {
  const match = line.match(/(-?\$?\d+(?:\.\d{1,2})?)\s*$/);
  return match ? parseMoney(match[1]) : NaN;
}

function stripTrailingMoney(line: string): string {
  return line.replace(/\s*-?\$?\d+(?:\.\d{1,2})?\s*$/, "").trim();
}

function parseMoney(raw: unknown): number {
  const value = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(value) ? toMoney(value) : NaN;
}

function firstFiniteMoney(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = parseMoney(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = stringOrNull(value);
    if (normalized) return normalized;
  }
  return null;
}

function stringOrNull(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value || null;
}

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toMoney(value: number): number {
  return Number(value.toFixed(2));
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
