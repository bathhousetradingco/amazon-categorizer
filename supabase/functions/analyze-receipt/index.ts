import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ================= ENV ================= */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY")!;

/* ================= CORS ================= */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await safeJson(req);
    let filePath = body?.filePath;
    const categories: string[] = Array.isArray(body?.categories) ? body.categories : [];

    if (!filePath) throw new Error("Missing filePath");

    /* ================= FIX STORAGE PATH ================= */
    // If frontend sends "receipts/xyz.png"
    if (filePath.startsWith("receipts/")) {
      filePath = filePath.replace("receipts/", "");
    }

    console.log("Downloading from bucket path:", filePath);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    /* ================= DOWNLOAD RECEIPT ================= */
    const { data: fileBlob, error: dlErr } = await supabase
      .storage
      .from("receipts")
      .download(filePath);

    if (dlErr || !fileBlob) {
      console.error("Storage download error:", dlErr);
      throw new Error("Failed to download receipt from storage");
    }

    const base64 = await blobToBase64(fileBlob);

    /* ================= OCR (STRICT JSON) ================= */
    const ocrText = await openaiVisionOCR(base64);

    const parsed = extractJsonObject(ocrText);
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error("OCR did not return valid JSON with items[]");
    }

    /* ================= POST-FILTER (kill non-products) ================= */
    const cleanedItems = parsed.items
      .map((x: any) => ({
        name: typeof x?.name === "string" ? x.name.trim() : "",
        amount: Number(x?.amount),
        code: typeof x?.code === "string" ? x.code.trim() : null,
      }))
      .filter((x: any) => isValidProductLine(x.name, x.amount));

    const taxAmount = Number(parsed.tax || 0) || 0;

    /* ================= ENRICH + NORMALIZE ================= */
    const enriched = await Promise.all(
      cleanedItems.map(async (item: any) => {
        const raw = item.name;
        const amount = Number(item.amount) || 0;

        const codeFromText = extractProductCode(raw);
        const codeRaw = item.code || codeFromText?.raw || null;
        const codeNormalized = normalizeCode(codeRaw);

        let normalizedName = "";

        if (codeNormalized) {
          const { data: mem } = await supabase
            .from("product_match_memory")
            .select("product_name")
            .eq("product_code", codeNormalized)
            .maybeSingle();

          if (mem?.product_name) normalizedName = String(mem.product_name);
        }

        if (!normalizedName) {
          normalizedName = await cleanNameOneLine(raw);
        }

        let suggestedCategory = "Needs Review";
        if (categories.length) {
          suggestedCategory = await suggestCategory(normalizedName, categories);
        }

        return {
          raw_description: raw,
          normalized_description: normalizedName || raw,
          amount,
          suggested_category: suggestedCategory || "Needs Review",
          product_code: codeNormalized || null,
        };
      }),
    );

    return new Response(
      JSON.stringify({
        line_items: enriched,
        tax_amount: taxAmount,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    console.error("analyze-receipt error:", err);
    return new Response(
      JSON.stringify({
        error: err?.message || "Unknown error",
        stack: err?.stack || null,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

/* ================= HELPERS ================= */

async function safeJson(req: Request) {
  const txt = await req.text();
  if (!txt || !txt.trim()) return {};
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function openaiVisionOCR(base64: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
Extract ONLY purchasable line items from this receipt.

Hard rules:
- Each item MUST have a positive price (amount > 0).
- EXCLUDE: subtotal, total, tax lines, discounts, coupons, instant savings, change, balance, tender, card info.
- EXCLUDE "pricing math" lines like "36 AT 1 FOR 8.98".
- If a product code/UPC/SKU appears on the same line, include as "code".

Return JSON ONLY:
{
  "items": [
    { "name": "...", "amount": 0.00, "code": "optional" }
  ],
  "tax": 0.00
}
              `.trim(),
            },
            {
              type: "input_image",
              image_url: `data:image/png;base64,${base64}`,
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  const text = data?.output?.[0]?.content?.[0]?.text;
  if (!text) throw new Error("No OCR output from OpenAI");
  return String(text);
}
