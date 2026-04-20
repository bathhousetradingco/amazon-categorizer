export function inferReceiptMimeType(receiptPath: string, contentType?: string | null): string {
  const normalizedContentType = normalizeReceiptMimeType(contentType);
  if (isSupportedReceiptMimeType(normalizedContentType)) return normalizedContentType;

  const normalizedPath = String(receiptPath || "").toLowerCase();
  if (/\.pdf(?:$|[?#])/.test(normalizedPath)) return "application/pdf";
  if (/\.png(?:$|[?#])/.test(normalizedPath)) return "image/png";
  if (/\.webp(?:$|[?#])/.test(normalizedPath)) return "image/webp";
  if (/\.gif(?:$|[?#])/.test(normalizedPath)) return "image/gif";
  if (/\.(?:jpg|jpeg)(?:$|[?#])/.test(normalizedPath)) return "image/jpeg";

  return "image/jpeg";
}

export function isPdfReceipt(receiptPath: string, contentType?: string | null): boolean {
  return inferReceiptMimeType(receiptPath, contentType) === "application/pdf";
}

export function sniffReceiptMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) {
    return "image/gif";
  }

  if (bytes.length >= 12 && startsWithAscii(bytes.subarray(0, 4), "RIFF") && startsWithAscii(bytes.subarray(8, 12), "WEBP")) {
    return "image/webp";
  }

  if (startsWithAscii(bytes, "%PDF-")) {
    return "application/pdf";
  }

  if (isHeifFamilyImage(bytes)) {
    return "image/heic";
  }

  return "";
}

export function unwrapStoredDataUrl(bytes: Uint8Array): { bytes: Uint8Array; mimeType: string } | null {
  const prefix = decodeAscii(bytes.subarray(0, Math.min(bytes.length, 64))).trimStart();
  if (!prefix.toLowerCase().startsWith("data:")) return null;

  const text = new TextDecoder().decode(bytes);
  const match = text.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i);
  if (!match) return null;

  try {
    const binary = atob(match[2].replace(/\s/g, ""));
    const decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      decoded[i] = binary.charCodeAt(i);
    }
    return {
      bytes: decoded,
      mimeType: normalizeReceiptMimeType(match[1]),
    };
  } catch {
    return null;
  }
}

export function isSupportedReceiptMimeType(value: string): boolean {
  return [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ].includes(normalizeReceiptMimeType(value));
}

export function isUnsupportedReceiptMimeType(value: string): boolean {
  return [
    "image/heic",
    "image/heif",
    "image/tiff",
    "image/bmp",
    "image/avif",
  ].includes(normalizeReceiptMimeType(value));
}

export function extractFilename(path: string): string {
  const normalized = String(path || "").trim().replace(/^\/+/, "");
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

function normalizeReceiptMimeType(value?: string | null): string {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  if (bytes.length < value.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (bytes[i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function decodeAscii(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return value;
}

function isHeifFamilyImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !startsWithAscii(bytes.subarray(4, 8), "ftyp")) return false;
  const header = decodeAscii(bytes.subarray(8, Math.min(bytes.length, 64))).toLowerCase();
  return [
    "heic",
    "heix",
    "hevc",
    "hevx",
    "heif",
    "heis",
    "mif1",
    "msf1",
  ].some((brand) => header.includes(brand));
}
