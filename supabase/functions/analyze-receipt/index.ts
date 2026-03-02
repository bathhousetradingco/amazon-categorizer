import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

  const origin = req.headers.get("origin") || "";

  const headers = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  // ✅ Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers }
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing environment variables" }),
        { status: 500, headers }
      );
    }

    const body = await req.json();
    const { filePath, categories } = body;

    if (!filePath) {
      return new Response(
        JSON.stringify({ error: "Missing filePath" }),
        { status: 400, headers }
      );
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    // ⚠️ Make sure your bucket name is correct
    const { data: signedData, error: signedError } =
      await supabase.storage
        .from("receipts")  // <-- change if your bucket name differs
        .createSignedUrl(filePath, 60);

    if (signedError || !signedData?.signedUrl) {
      return new Response(
        JSON.stringify({ error: "Failed to access receipt file" }),
        { status: 400, headers }
      );
    }

    const systemPrompt = `
You are a bookkeeping assistant.

Extract purchasable line items only.
Ignore totals and payment info.

Return STRICT JSON:
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

    const openaiResponse = await fetch(
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

    const openaiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return new Response(
        JSON.stringify({ error: openaiData }),
        { status: 500, headers }
      );
    }

    const content = openaiData?.choices?.[0]?.message?.content;

    if (!content) {
      return new Response(
        JSON.stringify({ error: "No AI response returned" }),
        { status: 500, headers }
      );
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      return new Response(
        JSON.stringify({ error: "AI returned invalid JSON", raw: content }),
        { status: 500, headers }
      );
    }

    return new Response(
      JSON.stringify(parsed),
      { status: 200, headers }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers }
    );
  }
});
