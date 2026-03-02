import { HttpError } from "./http.ts";

const STORAGE_MARKER = "/storage/v1/object/";

export type ParsedReceiptItem = {
  name: string;
  amount: number;
  code: string | null;
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

    if (bucket !== "receipts") {
      throw new HttpError(400, "filePath must reference the receipts bucket");
    }

    normalized = objectParts.join("/");
  }

  normalized = normalized.replace(/^\/+/, "");

  if (!normalized) {
    throw new HttpError(400, "Invalid filePath");
  }

  return normalized;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

export function parseReceiptItems(rawItems: unknown): ParsedReceiptItem[] {
  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map((entry): ParsedReceiptItem => ({
      name: String((entry as any)?.name ?? "").trim(),
      amount: parseCurrencyToNumber((entry as any)?.amount),
      code: normalizeCode((entry as any)?.code),
    }))
    .filter((item) => isLikelyReceiptLineItem(item.name, item.amount));
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

export function isLikelyReceiptLineItem(name: string, amount: number): boolean {
  if (!name || !Number.isFinite(amount) || amount <= 0) return false;

  const blacklist = [
    "subtotal",
    "sub total",
    "total",
    "tax",
    "discount",
    "coupon",
    "change",
    "cash",
    "visa",
    "mastercard",
  ];

  const lowered = name.toLowerCase();
  return !blacklist.some((token) => lowered.includes(token));
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) return null;

  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
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
