import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildAskAiPrompt, normalizeCategories } from "./prompt.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

    const { userInput, categories, transactionContext, receiptItemContext } = await req.json();

    if (!userInput || !Array.isArray(categories)) {
      return new Response(JSON.stringify({ error: "Missing userInput or categories" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedCategories = normalizeCategories(categories);
    const prompt = buildAskAiPrompt(
      {
        user_input: String(userInput),
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
      },
      normalizedCategories,
    );

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          },
        ],
      }),
    });

    const json = await openaiRes.json();

    if (!openaiRes.ok) {
      return new Response(JSON.stringify({ error: json?.error?.message || "OpenAI failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text = json?.output?.[0]?.content?.[0]?.text || "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const clean = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;

    const parsed = JSON.parse(clean);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "ask-ai failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}); 
