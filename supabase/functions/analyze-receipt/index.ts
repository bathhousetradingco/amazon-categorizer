// supabase/functions/analyze-receipt/index.ts

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const { filePath, categories } = await req.json();

    if (!filePath) {
      return json({ error: "Missing filePath" }, 400);
    }

    // 🔹 Create signed URL for receipt
    const { data: signedData, error: signedError } =
      await supabase.storage
        .from("receipts")
        .createSignedUrl(filePath, 60);

    if (signedError || !signedData?.signedUrl) {
      console.error("Signed URL error:", signedError);
      return json({ error: "Failed to access receipt" }, 400);
    }

    const receiptUrl = signedData.signedUrl;

    // 🔹 Build AI prompt
    const systemPrompt = `
You are a bookkeeping assistant.

Extract clean line items from the receipt image.

Rules:
- Ignore totals
- Ignore subtotal
- Ignore payment method
- Ignore store info
- Extract ONLY purchasable items
- Include tax separately if present
- Return JSON only

Return format:
{
  "line_items": [
    {
      "raw_description": "original line text",
      "normalized_description": "cleaned item name",
      "amount": 12.34,
      "suggested_category": "Best category from list"
    }
  ],
  "tax_amount": 1.23
}

Allowed categories:
${(categories || []).join(", ")}
`;

    // 🔹 Call OpenAI Vision
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
                image_url: { url: receiptUrl }
              }
            ]
          }
        ]
      })
    });

    const openaiData = await openaiRes.json();

    if (!openaiRes.ok) {
      console.error("OpenAI error:", openaiData);
      return json({ error: "OpenAI request failed" }, 500);
    }

    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      return json({ error: "No AI response" }, 500);
    }

    // 🔹 Safely parse JSON from AI response
    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error("JSON parse error:", content);
      return json({ error: "AI returned invalid JSON" }, 500);
    }

    return json(parsed);

  } catch (err) {
    console.error("Unexpected error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*"
    }
  });
}
