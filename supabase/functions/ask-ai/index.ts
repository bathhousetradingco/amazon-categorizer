import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

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
  console.log("🚀 AUTO DEPLOY TEST - " + new Date().toISOString());

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { userInput, categories } = await req.json();

    if (!userInput || !Array.isArray(categories)) {
      return new Response(JSON.stringify({ error: "Missing userInput or categories" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = `
You are helping categorize a small business transaction for Bathhouse Trading Co.

User context:
"${userInput}"

Choose ONE category from this list ONLY:
${categories.map((c: string) => `- ${c}`).join("\n")}

Return STRICT JSON ONLY:
{
  "category": "...",
  "reasoning": "...",
  "confidence": "High|Medium|Low"
}

Rules:
- category MUST match exactly one of the provided categories
- if unsure: "Needs Review"
`;

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
