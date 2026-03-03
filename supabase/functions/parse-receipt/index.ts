import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";
import {
  groupSamsClubReceiptLines,
  isAcceptableProductTitle,
  parseSamsClubGroup,
} from "../_shared/sams-club-receipt.ts";

type SerpApiPayload = {
  organic_results?: Array<{ title?: string }>;
  shopping_results?: Array<{ title?: string }>;
};

type ItemResult = {
  raw_line: string;
  item_number_raw: string | null;
  item_number_normalized: string | null;
  quantity: number;
  serpapi_query: string | null;
  serpapi_first_title: string | null;
  final_title_used: string | null;
  status: "ok" | "parse_invalid" | "enrich_failed";
};

const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await parseJsonBody(req);
    const rawLines = extractRawLines(body);

    const groups = groupSamsClubReceiptLines(rawLines);
    const results: ItemResult[] = [];

    for (const group of groups) {
      const parsed = parseSamsClubGroup(group);

      if (!parsed) {
        const invalidResult: ItemResult = {
          raw_line: group.line1,
          item_number_raw: null,
          item_number_normalized: null,
          quantity: 1,
          serpapi_query: null,
          serpapi_first_title: null,
          final_title_used: null,
          status: "parse_invalid",
        };
        console.log("PARSE_RESULT", invalidResult);
        results.push(invalidResult);
        continue;
      }

      console.log("PARSE_RESULT", {
        raw_line: parsed.raw_line,
        item_number_raw: parsed.item_number_raw,
        item_number_normalized: parsed.item_number_normalized,
      });
      console.log("QUANTITY_DETECTED", {
        item_number_normalized: parsed.item_number_normalized,
        quantity: parsed.quantity,
      });

      const serpapi_query = parsed.item_number_normalized;
      console.log("SERPAPI_REQUEST", { query: serpapi_query });

      const { firstTitle, ok } = await fetchSerpApiFirstTitle(serpapi_query);
      console.log("SERPAPI_RESPONSE", {
        item_number_normalized: parsed.item_number_normalized,
        status: ok ? "ok" : "error",
        first_title: firstTitle,
      });

      if (!ok || !isAcceptableProductTitle(firstTitle)) {
        const failedResult: ItemResult = {
          raw_line: parsed.raw_line,
          item_number_raw: parsed.item_number_raw,
          item_number_normalized: parsed.item_number_normalized,
          quantity: parsed.quantity,
          serpapi_query,
          serpapi_first_title: firstTitle,
          final_title_used: null,
          status: "enrich_failed",
        };
        console.log("FINAL_SELECTION", failedResult);
        results.push(failedResult);
        continue;
      }

      const successResult: ItemResult = {
        raw_line: parsed.raw_line,
        item_number_raw: parsed.item_number_raw,
        item_number_normalized: parsed.item_number_normalized,
        quantity: parsed.quantity,
        serpapi_query,
        serpapi_first_title: firstTitle,
        final_title_used: firstTitle,
        status: "ok",
      };
      console.log("FINAL_SELECTION", successResult);
      results.push(successResult);
    }

    return jsonResponse({
      success: true,
      data: {
        store: "sams_club",
        items: results,
      },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    return jsonResponse(
      {
        success: false,
        error: {
          code: `PARSE_RECEIPT_${httpError.status}`,
          message: httpError.message,
          details: httpError.details ?? null,
        },
      },
      httpError.status,
    );
  }
});

function extractRawLines(body: Record<string, unknown>): string[] {
  const candidates = [body.raw_lines, body.rawLines, body.lines, body.ocr_lines];
  const lines = candidates.find((value) => Array.isArray(value));
  return Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
}

async function fetchSerpApiFirstTitle(query: string): Promise<{ firstTitle: string | null; ok: boolean }> {
  if (!SERPAPI_API_KEY) return { firstTitle: null, ok: false };

  const endpoint = new URL("https://serpapi.com/search.json");
  endpoint.searchParams.set("engine", "google");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("api_key", SERPAPI_API_KEY);

  const response = await fetch(endpoint.toString(), { method: "GET" });
  if (!response.ok) return { firstTitle: null, ok: false };

  const payload = await response.json() as SerpApiPayload;
  const firstTitle = payload.organic_results?.[0]?.title?.trim()
    || payload.shopping_results?.[0]?.title?.trim()
    || null;

  return { firstTitle, ok: Boolean(firstTitle) };
}
