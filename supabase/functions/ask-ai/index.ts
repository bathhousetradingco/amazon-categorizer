import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildAskAiPrompt, normalizeCategories } from "./prompt.ts";
import { applyTaxGuidance, buildTaxGuidancePromptBlock, lookupTaxGuidance } from "./tax-guidance.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEFAULT_TAX_YEAR = 2026;
const ASK_AI_MODEL = Deno.env.get("ASK_AI_MODEL") || "gpt-4.1-mini";
const ASK_AI_TAX_WEB_SEARCH = Deno.env.get("ASK_AI_TAX_WEB_SEARCH") !== "off";

/* =========================
   CORS
========================= */
const ALLOWED_ORIGINS = new Set([
  "https://bathhousetradingco.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5500",
]);

function cors(origin: string | null) {
  const allowOrigin =
    origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://bathhousetradingco.github.io";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = cors(origin);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { userInput, categories, transactionContext, receiptItemContext, taxYear, tax_year } = await req.json();

    if (!userInput || !Array.isArray(categories)) {
      return new Response(JSON.stringify({ error: "Missing userInput or categories" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedCategories = normalizeCategories(categories);
    const requestedTaxYear = Number(taxYear ?? tax_year);
    const effectiveTaxYear = Number.isInteger(requestedTaxYear) && requestedTaxYear >= 2020 && requestedTaxYear <= 2100
      ? requestedTaxYear
      : DEFAULT_TAX_YEAR;
    const askAiContext = {
      user_input: String(userInput),
      tax_year: effectiveTaxYear,
      transaction: transactionContext && typeof transactionContext === "object"
        ? {
          title: String(transactionContext.title || "").trim() || null,
          vendor: String(transactionContext.vendor || "").trim() || null,
          amount: Number(transactionContext.amount),
          institution: String(transactionContext.institution || "").trim() || null,
          current_category: String(transactionContext.current_category || "").trim() || null,
        }
        : undefined,
      receipt_item: receiptItemContext && typeof receiptItemContext === "object"
        ? {
          item_number: String(receiptItemContext.item_number || "").trim() || null,
          product_name: String(receiptItemContext.product_name || "").trim() || null,
          receipt_label: String(receiptItemContext.receipt_label || "").trim() || null,
          amount: Number(receiptItemContext.amount),
        }
        : undefined,
    };
    const taxGuidance = lookupTaxGuidance(askAiContext, normalizedCategories);
    const prompt = buildAskAiPrompt(
      askAiContext,
      normalizedCategories,
      buildTaxGuidancePromptBlock(taxGuidance),
    );

    const openAiBody: Record<string, unknown> = {
      model: ASK_AI_MODEL,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
    };

    if (ASK_AI_TAX_WEB_SEARCH) {
      openAiBody.tools = [
        {
          type: "web_search",
          filters: {
            allowed_domains: ["irs.gov"],
          },
          search_context_size: "low",
          user_location: {
            type: "approximate",
            country: "US",
            timezone: "America/Chicago",
          },
        },
      ];
      openAiBody.tool_choice = "auto";
      openAiBody.include = ["web_search_call.action.sources"];
    }

    let openaiRes = await callOpenAiResponses(openAiBody);
    let json = await openaiRes.json();

    if (!openaiRes.ok && ASK_AI_TAX_WEB_SEARCH && shouldRetryWithoutWebSearch(json)) {
      delete openAiBody.tools;
      delete openAiBody.tool_choice;
      delete openAiBody.include;
      openaiRes = await callOpenAiResponses(openAiBody);
      json = await openaiRes.json();
    }

    if (!openaiRes.ok) {
      return new Response(JSON.stringify({ error: json?.error?.message || "OpenAI failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text = extractResponseText(json);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const clean = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;

    const parsed = applyTaxGuidance(JSON.parse(clean), taxGuidance, normalizedCategories);
    const taxResearchUsed = usedWebSearch(json);

    return new Response(JSON.stringify({
      ...parsed,
      tax_year: effectiveTaxYear,
      tax_research_used: taxResearchUsed,
      tax_research_sources: taxResearchUsed ? extractWebSearchSources(json) : [],
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "ask-ai failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}); 

function callOpenAiResponses(body: Record<string, unknown>): Promise<Response> {
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function shouldRetryWithoutWebSearch(json: any): boolean {
  const message = String(json?.error?.message || "").toLowerCase();
  return /web_search|tool|tools|include|unsupported|unknown parameter|invalid/i.test(message);
}

function extractResponseText(json: any): string {
  const outputs = Array.isArray(json?.output) ? json.output : [];
  const message = outputs.find((item: any) => item?.type === "message" && Array.isArray(item.content));
  const content = message?.content?.find((item: any) =>
    typeof item?.text === "string" &&
    (item.type === "output_text" || item.type === "text" || !item.type)
  );

  if (content?.text) return content.text;

  for (const output of outputs) {
    const fallback = Array.isArray(output?.content)
      ? output.content.find((item: any) => typeof item?.text === "string")
      : null;
    if (fallback?.text) return fallback.text;
  }

  return "";
}

function usedWebSearch(json: any): boolean {
  return Array.isArray(json?.output) && json.output.some((item: any) =>
    String(item?.type || "").includes("web_search"),
  );
}

function extractWebSearchSources(json: any): Array<{ title: string; url: string }> {
  const sources = new Map<string, string>();
  const outputs = Array.isArray(json?.output) ? json.output : [];

  for (const output of outputs) {
    if (output?.type === "message" && Array.isArray(output.content)) {
      for (const content of output.content) {
        if (!Array.isArray(content?.annotations)) continue;

        for (const annotation of content.annotations) {
          if (annotation?.type !== "url_citation") continue;
          addWebSearchSource(sources, annotation.url, annotation.title);
        }
      }
    }

    if (String(output?.type || "").includes("web_search")) {
      const actionSources = Array.isArray(output?.action?.sources) ? output.action.sources : [];
      for (const source of actionSources) {
        addWebSearchSource(sources, source?.url || source?.uri || source?.link, source?.title || source?.name);
      }
    }
  }

  return [...sources.entries()].slice(0, 5).map(([url, title]) => ({ url, title }));
}

function addWebSearchSource(sources: Map<string, string>, rawUrl: unknown, rawTitle: unknown) {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return;

  let hostname = "IRS source";
  try {
    hostname = new URL(url).hostname;
  } catch (_err) {
    return;
  }

  const title = String(rawTitle || "").replace(/\s+/g, " ").trim() || hostname;
  if (!sources.has(url)) sources.set(url, title);
}
