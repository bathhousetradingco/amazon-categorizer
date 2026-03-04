import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";
import {
  applyCategorySuggestions,
  parseReceiptLines,
  resolveProductNames,
  validateReceiptMath,
  type IngestedReceipt,
} from "../_shared/receipt-pipeline.ts";

const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await parseJsonBody(req);
    const categories = Array.isArray(body.categories) ? body.categories.map((v) => String(v ?? "").trim()).filter(Boolean) : [];

    const ingested: IngestedReceipt = {
      store: stringOrNull(body.store),
      date: stringOrNull(body.date),
      raw: (body.raw && typeof body.raw === "object") ? body.raw as Record<string, unknown> : {},
      raw_text_lines: extractLines(body),
      structured_blocks: Array.isArray(body.structured_blocks)
        ? body.structured_blocks.filter((v: unknown) => v && typeof v === "object") as Record<string, unknown>[]
        : [],
      structured_items: extractStructuredItems(body),
      subtotal_hint: parseMoney(body.subtotal),
      tax_hint: parseMoney(body.tax),
      total_hint: parseMoney(body.total),
    };

    const parsed = parseReceiptLines(ingested);
    const named = await resolveProductNames({ items: parsed.items, serpApiKey: SERPAPI_API_KEY });
    const categorized = applyCategorySuggestions(named, categories);
    const receipt = { ...parsed, items: categorized };
    const validation = validateReceiptMath(receipt);

    return jsonResponse({
      success: true,
      data: {
        receipt,
        validation,
        raw_ocr: {
          raw: ingested.raw,
          raw_text_lines: ingested.raw_text_lines,
          structured_blocks: ingested.structured_blocks,
        },
      },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    return jsonResponse({
      success: false,
      error: {
        code: `PARSE_RECEIPT_${httpError.status}`,
        message: httpError.message,
        details: httpError.details ?? null,
      },
    }, httpError.status);
  }
});

function extractLines(body: Record<string, unknown>): string[] {
  const candidates = [body.raw_text_lines, body.rawLines, body.lines, body.ocr_lines];
  const lines = candidates.find((value) => Array.isArray(value));
  return Array.isArray(lines) ? lines.map((line) => String(line ?? "").trim()).filter(Boolean) : [];
}

function extractStructuredItems(body: Record<string, unknown>): Array<{ description: string; amount: number | null; product_number: string | null }> {
  const rawItems = [body.structured_items, body.items].find((value) => Array.isArray(value));
  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map((item: any) => {
      const description = String(item?.description ?? item?.name ?? item?.title ?? "").trim();
      const amount = parseMoney(item?.amount ?? item?.total ?? item?.price);
      const product_number = normalizeProductNumber(item?.product_number ?? item?.code ?? item?.sku ?? item?.barcode);
      return { description, amount, product_number };
    })
    .filter((item) => item.description);
}

function normalizeProductNumber(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits || digits.length < 6 || digits.length > 14) return null;
  return digits.replace(/^0+/, "") || "0";
}

function parseMoney(raw: unknown): number | null {
  const parsed = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function stringOrNull(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value || null;
}
