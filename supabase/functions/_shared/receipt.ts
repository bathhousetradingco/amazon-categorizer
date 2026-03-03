import { HttpError } from "./http.ts";
import {
  extractSKU,
  isNonPurchasableLine,
  normalizeLineItem,
  parseQuantityAndPrice,
  scoreLineItemQuality,
} from "./line-items.ts";

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

export function buildOcrInput(asset: ReceiptAsset): Array<Record<string, unknown>> {
  const prompt = {
    type: "input_text",
    text:
      "Extract purchasable line items from this receipt. Return JSON only with shape {\"items\":[{\"name\":string,\"amount\":number|string,\"code\":string|null}],\"tax\":number|string,\"total\":number|string,\"store\":string|null}. Keep quantity and unit price hints in item names (e.g. '36 @ 8.98', '36CT'). Do not include subtotal/total/payment lines as items.",
  };

  if (asset.mimeType === "application/pdf") {
    return [
      prompt,
      {
        type: "input_file",
        filename: `receipt.${asset.extension}`,
        file_data: `data:${asset.mimeType};base64,${asset.base64}`,
      },
    ];
  }

  return [
    prompt,
    {
      type: "input_image",
      image_url: `data:${asset.mimeType};base64,${asset.base64}`,
    },
  ];
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

    const isContinuation = name && (!Number.isFinite(amount) || amount <= 0) && String(next.name ?? "").trim();
    if (isContinuation) {
      mergedEntries.push({
        ...next,
        name: `${name} ${String(next.name ?? "")}`.trim(),
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
  return entries
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
        qualityScore: quantity.score,
        qualityFlags,
      };
    })
    .filter((item) => !isNonPurchasableLine(item.name, item.total));
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
