export function inferReceiptMimeType(receiptPath: string, contentType?: string | null): string {
  const normalizedContentType = String(contentType || "").split(";")[0].trim().toLowerCase();
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

export function extractFilename(path: string): string {
  const normalized = String(path || "").trim().replace(/^\/+/, "");
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

function isSupportedReceiptMimeType(value: string): boolean {
  return [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ].includes(value);
}
