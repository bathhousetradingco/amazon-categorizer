import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";
import {
  applyCategorySuggestions,
  parseReceiptWithOpenAI,
  resolveProductNames,
  validateReceiptMath,
  type IngestedReceipt,
} from "../_shared/receipt-pipeline.ts";

const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? undefined;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await parseJsonBody(req);
    const categories = Array.isArray(body.categories) ? body.categories.map((v) => String(v ?? "").trim()).filter(Boolean) : [];

    const ingested: IngestedReceipt = {
      store: stringOrNull(body.store),
      date: stringOrNull(body.date),
      raw: (body.raw && typeof body.raw === "object") ? body.raw as Record<string, unknown> : {},
      raw_text: extractRawText(body),
      raw_text_lines: extractLines(body),
      structured_blocks: Array.isArray(body.structured_blocks)
        ? body.structured_blocks.filter((v: unknown) => v && typeof v === "object") as Record<string, unknown>[]
        : [],
      subtotal_hint: parseMoney(body.subtotal),
      tax_hint: parseMoney(body.tax),
      total_hint: parseMoney(body.total),
    };

    const parsedItems = await parseReceiptWithOpenAI({ ocrText: ingested.raw_text, apiKey: OPENAI_API_KEY });
    const named = await resolveProductNames({ items: parsedItems, serpApiKey: SERPAPI_API_KEY, openAiKey: OPENAI_API_KEY });
    const lineItems = applyCategorySuggestions(named, categories);
    const validation = validateReceiptMath({
      items: lineItems,
      subtotalHint: ingested.subtotal_hint,
      taxHint: ingested.tax_hint,
      totalHint: ingested.total_hint,
    });

    return jsonResponse({
      success: true,
      data: {
        line_items: lineItems,
        validation,
        raw_ocr: {
          raw: ingested.raw,
          raw_text: ingested.raw_text,
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

function extractRawText(body: Record<string, unknown>): string {
  const explicit = String(body.raw_text ?? body.rawText ?? "").trim();
  if (explicit) return explicit;
  return extractLines(body).join("\n");
}

function parseMoney(raw: unknown): number | null {
  const parsed = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function stringOrNull(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value || null;
}
