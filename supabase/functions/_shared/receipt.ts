import { HttpError } from "./http.ts";
import {
  extractSKU,
  isNonPurchasableLine,
  normalizeLineItem,
  parseQuantityAndPrice,
  scoreLineItemQuality,
} from "./line-items.ts";
import { fetchWithTimeout } from "./fetch.ts";

const STORAGE_MARKER = "/storage/v1/object/";

const RECEIPTS_BUCKET = "receipts";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

export type ParsedReceiptItem = {
  rawName: string;
  name: string;
  amount: number;
  code: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  totalMismatch: boolean;
  qualityScore: number;
  qualityFlags: string[];
};

export type ParseReceiptItemOptions = {
  store?: "sams_club" | "walmart" | "generic";
};

export type ReceiptAsset = {
  filePath: string;
  blob: Blob;
  mimeType: string;
  extension: string;
  base64: string;
};

export type TabscannerReceiptData = {
  items: Array<{ name: string; amount: number | string; code: string | null }>;
  tax: number | string | null;
  total: number | string | null;
  subtotal: number | string | null;
  store: string | null;
  merchant: string | null;
  raw: Record<string, unknown>;
};

const storeParsers = {
  sams_club: parseSamsClubReceipt,
  walmart: parseWalmartReceipt,
  generic: parseGenericReceipt,
};

export function normalizeIncomingFilePath(inputPath: unknown): string {
  const path = String(inputPath ?? "").trim();
  if (!path) throw new HttpError(400, "Missing filePath");

  let normalized = path;

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    const url = new URL(normalized);
    const markerIndex = url.pathname.indexOf(STORAGE_MARKER);

    if (markerIndex === -1) {
      throw new HttpError(400, "filePath URL is not a Supabase storage URL");
    }

    const storagePath = url.pathname.slice(markerIndex + STORAGE_MARKER.length);
    const segments = storagePath.split("/").filter(Boolean);

    if (segments.length < 3) {
      throw new HttpError(400, "Invalid storage URL path");
    }

    const [, bucket, ...objectParts] = segments;

    if (bucket !== RECEIPTS_BUCKET) {
      throw new HttpError(400, `filePath must reference the ${RECEIPTS_BUCKET} bucket`);
    }

    normalized = objectParts.join("/");
  }

  normalized = normalized.replace(/^\/+/, "");

  if (!normalized) {
    throw new HttpError(400, "Invalid filePath");
  }

  return normalized;
}

export async function prepareReceiptAsset(filePath: string, blob: Blob): Promise<ReceiptAsset> {
  if (!blob || blob.size === 0) {
    throw new HttpError(422, "Receipt file is empty");
  }

  if (blob.size > MAX_RECEIPT_BYTES) {
    throw new HttpError(413, "Receipt file is too large for OCR", {
      max_bytes: MAX_RECEIPT_BYTES,
      actual_bytes: blob.size,
    });
  }

  const extension = inferExtension(filePath, blob.type);
  const mimeType = inferMimeType(extension, blob.type);

  if (!isSupportedMimeType(mimeType)) {
    throw new HttpError(415, "Unsupported receipt file type", {
      mime_type: mimeType,
      supported: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
    });
  }

  return {
    filePath,
    blob,
    mimeType,
    extension,
    base64: await blobToBase64(blob),
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildOcrInput(
  asset: ReceiptAsset,
  options: { tabscannerData?: TabscannerReceiptData | null } = {},
): Array<Record<string, unknown>> {
  const prompt = {
    type: "input_text",
    text:
      "Extract purchasable line items from this receipt. Return JSON only with shape {\"items\":[{\"name\":string,\"amount\":number|string,\"code\":string|null}],\"tax\":number|string,\"total\":number|string,\"store\":string|null}. Keep quantity and unit price hints in item names (e.g. '36 @ 8.98', '36CT'). Capture product numbers/SKU/item codes into code whenever present, especially 8-14 digit identifiers commonly printed on warehouse receipts. Do not include subtotal/total/payment lines as items.",
  };

  const tabscannerContext = options.tabscannerData
    ? {
      type: "input_text",
      text:
        `Tabscanner OCR candidate JSON (prefer its numeric totals and item prices when confidence conflicts): ${JSON.stringify(options.tabscannerData)}`,
    }
    : null;

  if (asset.mimeType === "application/pdf") {
    return [
      prompt,
      ...(tabscannerContext ? [tabscannerContext] : []),
      {
        type: "input_file",
        filename: `receipt.${asset.extension}`,
        file_data: `data:${asset.mimeType};base64,${asset.base64}`,
      },
    ];
  }

  return [
    prompt,
    ...(tabscannerContext ? [tabscannerContext] : []),
    {
      type: "input_image",
      image_url: `data:${asset.mimeType};base64,${asset.base64}`,
    },
  ];
}

export function mergeExtractedReceiptItems(primaryItems: unknown, tabscannerItems: unknown): unknown[] {
  const primary = Array.isArray(primaryItems) ? primaryItems : [];
  const secondary = Array.isArray(tabscannerItems) ? tabscannerItems : [];
  if (!secondary.length) return primary;
  if (!primary.length) return secondary;

  const byCode = new Map<string, any>();
  const byNameAmount = new Map<string, any[]>();
  (secondary as any[]).forEach((item, index) => {
    const code = normalizeLookupCode(item?.code);
    const amount = parseCurrencyToNumber(item?.amount);
    const key = buildMergeKey(item?.name, amount);
    if (code) byCode.set(code, item);
    if (key) byNameAmount.set(key, [...(byNameAmount.get(key) ?? []), item]);
  });

  const merged = primary.map((item: any, index) => {
    const code = normalizeLookupCode(item?.code);
    const primaryAmount = parseCurrencyToNumber(item?.amount);
    const key = buildMergeKey(item?.name, primaryAmount);

    const byCodeMatch = code ? byCode.get(code) : null;
    const byNameMatch = !byCodeMatch && key ? (byNameAmount.get(key)?.[0] ?? null) : null;
    const byIndexMatch = !byCodeMatch && !byNameMatch ? (secondary[index] ?? null) : null;
    const match = byCodeMatch ?? byNameMatch ?? byIndexMatch;
    if (!match) return item;

    const mergedAmount = firstFiniteNumber(match.amount, item?.amount);
    return {
      ...item,
      amount: Number.isFinite(parseCurrencyToNumber(mergedAmount)) ? mergedAmount : item?.amount,
      code: item?.code ?? match.code ?? null,
      name: String(item?.name ?? "").trim() || match.name,
    };
  });

  for (const secondaryItem of secondary as any[]) {
    const used = merged.some((entry: any) => {
      const mergedCode = normalizeLookupCode(entry?.code);
      const secondaryCode = normalizeLookupCode(secondaryItem?.code);
      if (mergedCode && secondaryCode && mergedCode === secondaryCode) return true;

      const mergedKey = buildMergeKey(entry?.name, parseCurrencyToNumber(entry?.amount));
      const secondaryKey = buildMergeKey(secondaryItem?.name, parseCurrencyToNumber(secondaryItem?.amount));
      return Boolean(mergedKey && secondaryKey && mergedKey === secondaryKey);
    });

    if (!used) merged.push(secondaryItem);
  }

  return merged;
}

function normalizeLookupCode(raw: unknown): string | null {
  const value = String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").replace(/^0+/, "").trim();
  return value || null;
}

function buildMergeKey(rawName: unknown, amount: number): string | null {
  const normalizedName = String(rawName ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedName) return null;
  if (!Number.isFinite(amount)) return normalizedName;
  return `${normalizedName}|${amount.toFixed(2)}`;
}

function firstFiniteNumber(...values: unknown[]): unknown {
  for (const value of values) {
    if (Number.isFinite(parseCurrencyToNumber(value))) return value;
  }
  return values[0] ?? null;
}

export async function requestTabscannerExtraction(params: {
  asset: ReceiptAsset;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<TabscannerReceiptData | null> {
  const apiKey = params.apiKey?.trim();
  if (!apiKey) return null;

  const endpoint = Deno.env.get("TABSCANNER_API_URL") ?? "https://api.tabscanner.com";
  const timeoutMs = params.timeoutMs ?? 12000;
  const form = new FormData();
  form.append("file", new File([params.asset.blob], `receipt.${params.asset.extension}`, { type: params.asset.mimeType }));

  try {
    const submit = await fetchWithTimeout(`${endpoint}/api/2/process`, {
      method: "POST",
      headers: { apikey: apiKey },
      body: form,
    }, timeoutMs);
    const submitPayload = await safeParseJsonResponse(submit);
    if (!submit.ok) {
      console.warn("tabscanner_submit_failed", { status: submit.status, payload: submitPayload });
      return null;
    }

    const immediate = normalizeTabscannerPayload(submitPayload);
    if (immediate.items.length) return immediate;

    const jobId = String(submitPayload?.token ?? submitPayload?.id ?? submitPayload?.uuid ?? "").trim();
    if (!jobId) return null;

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const poll = await fetchWithTimeout(`${endpoint}/api/2/result/${jobId}`, {
        method: "GET",
        headers: { apikey: apiKey },
      }, timeoutMs);
      const pollPayload = await safeParseJsonResponse(poll);
      if (!poll.ok) continue;
      const normalized = normalizeTabscannerPayload(pollPayload);
      if (normalized.items.length || Number.isFinite(parseCurrencyToNumber(normalized.total))) {
        return normalized;
      }
    }
  } catch (error) {
    console.warn("tabscanner_request_failed", { error: String(error) });
  }

  return null;
}

function normalizeTabscannerPayload(payload: any): TabscannerReceiptData {
  const source = (payload?.result ?? payload?.data ?? payload ?? {}) as Record<string, unknown>;
  const rawItems = [
    source.items,
    source.lineItems,
    source.products,
    (source.receipt as any)?.items,
  ].find((value) => Array.isArray(value));

  const items = (Array.isArray(rawItems) ? rawItems : []).map((item: any) => ({
    name: String(item?.name ?? item?.description ?? item?.title ?? "").trim(),
    amount: item?.price ?? item?.amount ?? item?.total ?? "",
    code: item?.code ?? item?.sku ?? item?.barcode ?? null,
  })).filter((item) => item.name);

  return {
    items,
    tax: source.tax ?? source.totalTax ?? (source.receipt as any)?.tax ?? null,
    total: source.total ?? source.grandTotal ?? (source.receipt as any)?.total ?? null,
    subtotal: source.subtotal ?? source.subTotal ?? (source.receipt as any)?.subtotal ?? null,
    store: String(source.store ?? source.storeName ?? (source.receipt as any)?.store ?? "").trim() || null,
    merchant: String(source.merchant ?? source.merchantName ?? (source.receipt as any)?.merchant ?? "").trim() || null,
    raw: source,
  };
}

export async function safeParseJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function extractJsonFromModelResponse(payload: any): Record<string, unknown> | null {
  const textCandidates = [
    payload?.output_text,
    payload?.output?.[0]?.content?.[0]?.text,
    payload?.choices?.[0]?.message?.content,
  ].filter((value) => typeof value === "string") as string[];

  for (const text of textCandidates) {
    const parsed = parseFirstJsonObject(text);
    if (parsed) return parsed;
  }

  return null;
}

export function parseReceiptItems(rawItems: unknown, options: ParseReceiptItemOptions = {}): ParsedReceiptItem[] {
  const parser = storeParsers[options.store ?? "generic"];
  return parser(rawItems);
}

function parseGenericReceipt(rawItems: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(rawItems)) return [];
  return parseEntries(rawItems);
}

function parseWalmartReceipt(rawItems: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(rawItems)) return [];
  return parseEntries(rawItems);
}

function parseSamsClubReceipt(rawItems: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(rawItems)) return [];

  const mergedEntries: unknown[] = [];
  for (let index = 0; index < rawItems.length; index++) {
    const current = (rawItems[index] ?? {}) as Record<string, unknown>;
    const next = (rawItems[index + 1] ?? {}) as Record<string, unknown>;

    const name = String(current.name ?? "").trim();
    const amount = parseCurrencyToNumber(current.amount);
    const nextName = String(next.name ?? "").trim();
    const nextAmount = parseCurrencyToNumber(next.amount);

    const isDescriptorLine = /^\d{1,4}\s*(?:AT|@)\s*\d{0,4}\s*(?:FOR)?\s*\$?\d+(?:\.\d{1,2})?/i.test(name)
      || /^\d{1,4}\s+FOR\s+\$?\d+(?:\.\d{1,2})?/i.test(name)
      || /^INST\s+SV\b/i.test(name);

    if (isDescriptorLine && mergedEntries.length) {
      const previous = (mergedEntries[mergedEntries.length - 1] ?? {}) as Record<string, unknown>;
      const previousName = String(previous.name ?? "").trim();
      mergedEntries[mergedEntries.length - 1] = {
        ...previous,
        name: `${previousName} ${name}`.trim(),
        amount: Number.isFinite(amount) && amount > 0 ? amount : previous.amount,
        code: previous.code ?? current.code ?? null,
      };
      continue;
    }

    const isContinuation = name && (!Number.isFinite(amount) || amount <= 0) && nextName;
    const nextLooksLikeDescriptor = /^\d{1,4}\s*(?:AT|@)\s*\d{0,4}\s*(?:FOR)?\s*\$?\d+(?:\.\d{1,2})?/i.test(nextName)
      || /^\d{1,4}\s+FOR\s+\$?\d+(?:\.\d{1,2})?/i.test(nextName);

    if (isContinuation && !nextLooksLikeDescriptor) {
      mergedEntries.push({
        ...next,
        name: `${name} ${nextName}`.trim(),
        amount: Number.isFinite(nextAmount) && nextAmount > 0 ? nextAmount : amount,
        code: current.code ?? next.code ?? null,
      });
      index += 1;
      continue;
    }

    mergedEntries.push(current);
  }

  return parseEntries(mergedEntries);
}

function parseEntries(entries: unknown[]): ParsedReceiptItem[] {
  const parsedItems = entries
    .map((entry): ParsedReceiptItem => {
      const rawName = String((entry as any)?.name ?? "").trim();
      const code = normalizeCode((entry as any)?.code);
      const normalizedName = normalizeLineItem(rawName);
      const sku = extractSKU(rawName, code);
      const amount = parseCurrencyToNumber((entry as any)?.amount);
      const quantityAndPrice = parseQuantityAndPrice(`${rawName} ${String((entry as any)?.amount ?? "")}`, amount);
      const quality = scoreLineItemQuality(rawName, normalizedName, sku);
      const qualityFlags = [...quality.flags];

      if (quantityAndPrice.hasTotalMismatch) {
        qualityFlags.push("recalculated_total");
      }

      return {
        rawName,
        name: normalizedName || rawName,
        amount: quantityAndPrice.total,
        code,
        sku,
        quantity: quantityAndPrice.quantity,
        unitPrice: quantityAndPrice.unitPrice,
        total: quantityAndPrice.total,
        totalMismatch: quantityAndPrice.hasTotalMismatch,
        qualityScore: quality.score,
        qualityFlags,
      };
    })
    .filter((item) => !isNonPurchasableLine(item.name, item.total));

  return consolidatePromotionalDuplicates(parsedItems);
}

function consolidatePromotionalDuplicates(items: ParsedReceiptItem[]): ParsedReceiptItem[] {
  const consolidated: ParsedReceiptItem[] = [];
  const promoKeyToIndex = new Map<string, number>();

  for (const item of items) {
    if (!isPromotionQuantityLine(item)) {
      consolidated.push(item);
      continue;
    }

    const key = buildPromoMergeKey(item);
    if (!key) {
      consolidated.push(item);
      continue;
    }

    const existingIndex = promoKeyToIndex.get(key);
    if (existingIndex === undefined) {
      promoKeyToIndex.set(key, consolidated.length);
      consolidated.push(item);
      continue;
    }

    const existing = consolidated[existingIndex];
    const mergedQuantity = existing.quantity + item.quantity;
    const mergedTotal = toMoney(existing.total + item.total);
    const expectedTotal = toMoney(mergedQuantity * existing.unitPrice);

    consolidated[existingIndex] = {
      ...existing,
      quantity: mergedQuantity,
      amount: mergedTotal,
      total: mergedTotal,
      totalMismatch: Math.abs(mergedTotal - expectedTotal) > 0.02,
      qualityFlags: Array.from(new Set([...existing.qualityFlags, ...item.qualityFlags, "consolidated_duplicate_promo"])),
    };
  }

  return consolidated;
}

function isPromotionQuantityLine(item: ParsedReceiptItem): boolean {
  if (item.quantity <= 1) return false;
  return /\b\d{1,4}\s*(?:@|AT)\s*\d{0,4}\s*(?:FOR)?\s*\$?\d+(?:\.\d{1,2})?\b/i.test(item.rawName)
    || /\b\d{1,4}\s+FOR\s+\$?\d+(?:\.\d{1,2})?\b/i.test(item.rawName);
}

function buildPromoMergeKey(item: ParsedReceiptItem): string | null {
  const stableIdentifier = item.code ?? item.sku;
  if (!stableIdentifier) return null;
  const compactName = item.name.toLowerCase().replace(/\s+/g, " ").trim();
  return `${stableIdentifier}|${compactName}|${item.unitPrice}`;
}

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}

export function parseCurrencyToNumber(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Number(raw.toFixed(2)) : NaN;
  }

  if (typeof raw !== "string") return NaN;

  const cleaned = raw.replace(/[^\d.-]/g, "").trim();
  if (!cleaned) return NaN;

  const value = Number(cleaned);
  return Number.isFinite(value) ? Number(value.toFixed(2)) : NaN;
}

export function parseTax(raw: unknown): number {
  const parsed = parseCurrencyToNumber(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) return null;

  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const code = String(raw).trim();
  if (!code) return null;
  return code.replace(/^0+/, "") || null;
}

function inferExtension(filePath: string, blobType: string): string {
  const fromPath = filePath.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase();
  if (fromPath) return fromPath;

  if (blobType.includes("png")) return "png";
  if (blobType.includes("jpeg") || blobType.includes("jpg")) return "jpg";
  if (blobType.includes("webp")) return "webp";
  if (blobType.includes("pdf")) return "pdf";
  return "bin";
}

function inferMimeType(extension: string, blobType: string): string {
  if (blobType) return blobType;

  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function isSupportedMimeType(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mimeType);
}
