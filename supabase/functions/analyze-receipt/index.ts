import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

  // ✅ Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders()
    });
  }

  try {

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
      return json({ error: "Missing environment variables" }, 500);
    }

    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const { filePath, categories } = await req.json();

    if (!filePath) {
      return json({ error: "Missing filePath" }, 400);
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: signedData, error: signedError } =
      await supabase.storage
        .from("receipts")
        .createSignedUrl(filePath, 60);

    if (signedError || !signedData?.signedUrl) {
      return json({ error: "Failed to access receipt" }, 400);
    }

    const systemPrompt = `
You are a bookkeeping assistant.

Extract purchasable line items only.
Ignore totals and payment info.

Return JSON:
{
  "line_items": [
    {
      "raw_description": "",
      "normalized_description": "",
      "amount": 0,
      "suggested_category": ""
    }
  ],
  "tax_amount": 0
}

Allowed categories:
${(categories || []).join(", ")}
`;

    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o",
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: "Analyze this receipt." },
                {
                  type: "image_url",
                  image_url: { url: signedData.signedUrl }
                }
              ]
            }
          ]
        })
      }
    );

    const openaiData = await openaiRes.json();

    if (!openaiRes.ok) {
      return json({ error: openaiData }, 500);
    }

    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      return json({ error: "No AI response" }, 500);
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: "AI returned invalid JSON" }, 500);
    }

    return json(parsed);

  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders()
  });
}
