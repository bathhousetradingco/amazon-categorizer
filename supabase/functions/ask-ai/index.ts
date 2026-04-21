import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AskAiContext,
  buildAskAiPrompt,
  normalizeCategories,
} from "./prompt.ts";
import {
  applyTaxGuidance,
  buildTaxGuidancePromptBlock,
  lookupTaxGuidance,
} from "./tax-guidance.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEFAULT_TAX_YEAR = 2026;
const ASK_AI_MODEL = Deno.env.get("ASK_AI_MODEL") || "gpt-4.1-mini";
const ASK_AI_RESEARCH_MODEL = Deno.env.get("ASK_AI_RESEARCH_MODEL") ||
  "gpt-4.1";
const ASK_AI_TAX_WEB_SEARCH = Deno.env.get("ASK_AI_TAX_WEB_SEARCH") !== "off";

type TaxResearchResult = {
  used: boolean;
  summary: string;
  sources: Array<{ title: string; url: string }>;
};

const EMPTY_TAX_RESEARCH: TaxResearchResult = {
  used: false,
  summary: "",
  sources: [],
};

const ASK_AI_RESPONSE_FORMAT = {
  type: "json_schema",
  name: "ask_ai_category_recommendation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: { type: "string" },
      reasoning: { type: "string" },
      confidence: { type: "string", enum: ["High", "Medium", "Low"] },
      deduction_status: {
        type: "string",
        enum: ["Deductible", "Review Required", "Potentially Non-Deductible"],
      },
      tax_consideration: { type: "string" },
      follow_up_question: { type: "string" },
    },
    required: [
      "category",
      "reasoning",
      "confidence",
      "deduction_status",
      "tax_consideration",
      "follow_up_question",
    ],
  },
};

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
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://bathhousetradingco.github.io";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
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
    const { data: { user }, error: authError } = await authClient.auth
      .getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      userInput,
      categories,
      transactionContext,
      receiptItemContext,
      taxYear,
      tax_year,
    } = await req.json();

    if (!userInput || !Array.isArray(categories)) {
      return new Response(
        JSON.stringify({ error: "Missing userInput or categories" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const normalizedCategories = normalizeCategories(categories);
    const requestedTaxYear = Number(taxYear ?? tax_year);
    const effectiveTaxYear =
      Number.isInteger(requestedTaxYear) && requestedTaxYear >= 2020 &&
        requestedTaxYear <= 2100
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
          institution: String(transactionContext.institution || "").trim() ||
            null,
          current_category:
            String(transactionContext.current_category || "").trim() || null,
        }
        : undefined,
      receipt_item: receiptItemContext && typeof receiptItemContext === "object"
        ? {
          item_number: String(receiptItemContext.item_number || "").trim() ||
            null,
          product_name: String(receiptItemContext.product_name || "").trim() ||
            null,
          receipt_label:
            String(receiptItemContext.receipt_label || "").trim() || null,
          amount: Number(receiptItemContext.amount),
        }
        : undefined,
    };
    const taxGuidance = lookupTaxGuidance(askAiContext, normalizedCategories);
    const taxResearch = await runTaxResearchIfNeeded(askAiContext, taxGuidance);
    const prompt = buildAskAiPrompt(
      askAiContext,
      normalizedCategories,
      buildTaxGuidancePromptBlock(taxGuidance),
      buildTaxResearchPromptBlock(taxResearch),
    );

    const json = await callOpenAiForCategorization(prompt);
    const parsedJson = parseOpenAiJsonResponse(json);
    const parsed = applyTaxGuidance(
      parsedJson as Record<string, unknown>,
      taxGuidance,
      normalizedCategories,
    );

    return new Response(
      JSON.stringify({
        ...parsed,
        tax_year: effectiveTaxYear,
        tax_research_used: taxResearch.used,
        tax_research_sources: taxResearch.sources,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || "ask-ai failed" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

function buildCategorizationRequestBody(
  prompt: string,
  structuredOutput = true,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ASK_AI_MODEL,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
  };

  if (structuredOutput) {
    body.text = { format: ASK_AI_RESPONSE_FORMAT };
  }

  return body;
}

async function callOpenAiForCategorization(prompt: string): Promise<any> {
  let body = buildCategorizationRequestBody(prompt, true);
  let openaiRes = await callOpenAiResponses(body);
  let json = await parseJsonResponse(openaiRes);

  if (!openaiRes.ok && shouldRetryWithoutStructuredOutput(json)) {
    body = buildCategorizationRequestBody(prompt, false);
    openaiRes = await callOpenAiResponses(body);
    json = await parseJsonResponse(openaiRes);
  }

  if (!openaiRes.ok) {
    throw new Error(json?.error?.message || "OpenAI failed");
  }

  return json;
}

async function parseJsonResponse(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch (_err) {
    return {
      error: {
        message:
          `OpenAI returned a non-JSON response with status ${response.status}`,
      },
    };
  }
}

function parseOpenAiJsonResponse(json: any): unknown {
  const text = extractResponseText(json);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const clean = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;

  if (!clean.trim()) {
    throw new Error("OpenAI returned an empty AI suggestion.");
  }

  try {
    return JSON.parse(clean);
  } catch (_err) {
    throw new Error("OpenAI returned an unreadable AI suggestion.");
  }
}

function shouldRequestTaxResearch(
  context: AskAiContext,
  guidance: ReturnType<typeof lookupTaxGuidance>,
): boolean {
  const text = [
    context.user_input,
    context.transaction?.title,
    context.transaction?.vendor,
    context.receipt_item?.product_name,
    context.receipt_item?.receipt_label,
  ].filter(Boolean).join(" ").toLowerCase();

  if (
    /\b(tax code|irs|schedule c|deduct|deductible|deduction|capitalize|capitalization|depreciation|section 179|safe harbor|fringe|meal limit|accountant|tax treatment)\b/
      .test(text)
  ) {
    return true;
  }

  if (!guidance) return false;
  if (guidance.follow_up_question) return false;

  return false;
}

async function runTaxResearchIfNeeded(
  context: AskAiContext,
  guidance: ReturnType<typeof lookupTaxGuidance>,
): Promise<TaxResearchResult> {
  if (!ASK_AI_TAX_WEB_SEARCH || !shouldRequestTaxResearch(context, guidance)) {
    return EMPTY_TAX_RESEARCH;
  }

  const prompt = buildTaxResearchPrompt(context, guidance);
  const filtered = await callTaxResearch(prompt, true);
  if (filtered.result.used || !filtered.retry_without_filters) {
    return filtered.result;
  }

  const unfiltered = await callTaxResearch(prompt, false);
  return unfiltered.result;
}

async function callTaxResearch(
  prompt: string,
  useDomainFilters: boolean,
): Promise<{ result: TaxResearchResult; retry_without_filters: boolean }> {
  const body = buildTaxResearchRequestBody(prompt, useDomainFilters);
  const openaiRes = await callOpenAiResponses(body);
  const json = await parseJsonResponse(openaiRes);

  if (!openaiRes.ok) {
    const shouldRetry = useDomainFilters &&
      shouldRetryWithoutWebSearchFilters(json);
    return {
      result: EMPTY_TAX_RESEARCH,
      retry_without_filters: shouldRetry,
    };
  }

  const summary = cleanResearchSummary(extractResponseText(json));
  const sources = extractWebSearchSources(json);

  if (!summary || !sources.length) {
    return {
      result: EMPTY_TAX_RESEARCH,
      retry_without_filters: false,
    };
  }

  return {
    result: {
      used: true,
      summary,
      sources,
    },
    retry_without_filters: false,
  };
}

function buildTaxResearchRequestBody(
  prompt: string,
  useDomainFilters: boolean,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "web_search",
    search_context_size: "low",
    user_location: {
      type: "approximate",
      country: "US",
      timezone: "America/Chicago",
    },
  };

  if (useDomainFilters) {
    tool.filters = {
      allowed_domains: ["irs.gov", "www.irs.gov"],
    };
  }

  return {
    model: ASK_AI_RESEARCH_MODEL,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    tools: [tool],
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
  };
}

function buildTaxResearchPrompt(
  context: AskAiContext,
  guidance: ReturnType<typeof lookupTaxGuidance>,
): string {
  const details = [
    `Tax year: ${context.tax_year || DEFAULT_TAX_YEAR}`,
    `User explanation: ${context.user_input}`,
    context.transaction?.title
      ? `Transaction title: ${context.transaction.title}`
      : "",
    context.transaction?.vendor ? `Vendor: ${context.transaction.vendor}` : "",
    context.receipt_item?.product_name
      ? `Receipt product: ${context.receipt_item.product_name}`
      : "",
    context.receipt_item?.receipt_label
      ? `Receipt label: ${context.receipt_item.receipt_label}`
      : "",
    guidance
      ? `Current deterministic category read: ${guidance.recommended_category}`
      : "",
    guidance
      ? `Current deterministic tax issue: ${guidance.tax_consideration}`
      : "",
  ].filter(Boolean).join("\n");

  return [
    "Research U.S. federal tax guidance for a small business Schedule C categorization decision.",
    "Use only official IRS.gov sources. Ignore non-IRS sources even if web search returns them.",
    "Focus on the specific tax issue needed for categorization: Schedule C line area, COGS/inventory treatment, meal/fringe limitations, capitalization/depreciation, vehicle substantiation, or ordinary-and-necessary treatment.",
    "Return a concise plain-English research summary for another model to use. Do not give legal advice.",
    "",
    details,
  ].join("\n");
}

function buildTaxResearchPromptBlock(research: TaxResearchResult): string {
  if (!research.used || !research.summary || !research.sources.length) {
    return "";
  }

  return [
    "IRS research context:",
    `- Summary: ${research.summary}`,
    "- Sources:",
    ...research.sources.map((source) => `  - ${source.title}: ${source.url}`),
    "Use this research only for tax treatment. Still choose exactly one available category.",
  ].join("\n");
}

function cleanResearchSummary(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

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

function shouldRetryWithoutStructuredOutput(json: any): boolean {
  const message = String(json?.error?.message || "").toLowerCase();
  return /text|format|json_schema|schema|strict|unsupported|unknown parameter|invalid/i
    .test(message);
}

function shouldRetryWithoutWebSearchFilters(json: any): boolean {
  const message = String(json?.error?.message || "").toLowerCase();
  return /filter|filters|allowed_domains|unsupported|unknown parameter|invalid/i
    .test(message);
}

function extractResponseText(json: any): string {
  const outputs = Array.isArray(json?.output) ? json.output : [];
  const message = outputs.find((item: any) =>
    item?.type === "message" && Array.isArray(item.content)
  );
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

function extractWebSearchSources(
  json: any,
): Array<{ title: string; url: string }> {
  const sources = new Map<string, string>();
  const outputs = Array.isArray(json?.output) ? json.output : [];

  for (const output of outputs) {
    if (output?.type === "message" && Array.isArray(output.content)) {
      for (const content of output.content) {
        if (!Array.isArray(content?.annotations)) continue;

        for (const annotation of content.annotations) {
          if (annotation?.type !== "url_citation") continue;
          addWebSearchSource(
            sources,
            annotation.url || annotation?.url_citation?.url,
            annotation.title || annotation?.url_citation?.title,
          );
        }
      }
    }

    if (String(output?.type || "").includes("web_search")) {
      const actionSources = Array.isArray(output?.action?.sources)
        ? output.action.sources
        : [];
      for (const source of actionSources) {
        addWebSearchSource(
          sources,
          source?.url || source?.uri || source?.link,
          source?.title || source?.name,
        );
      }
    }
  }

  return [...sources.entries()].slice(0, 5).map(([url, title]) => ({
    url,
    title,
  }));
}

function addWebSearchSource(
  sources: Map<string, string>,
  rawUrl: unknown,
  rawTitle: unknown,
) {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return;
  if (!isIrsUrl(url)) return;

  let hostname = "IRS source";
  try {
    hostname = new URL(url).hostname;
  } catch (_err) {
    return;
  }

  const title = String(rawTitle || "").replace(/\s+/g, " ").trim() || hostname;
  if (!sources.has(url)) sources.set(url, title);
}

function isIrsUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === "irs.gov" || hostname.endsWith(".irs.gov");
  } catch (_err) {
    return false;
  }
}
