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
    /* ================= AUTH (FIXES 401) ================= */
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
    } = await userClient.auth.getUser();

    if (!user) throw new Error("Invalid or expired JWT");

    /* ================= BODY ================= */
    const body = await safeJson(req);
    let filePath = body?.filePath;
    const categories: string[] = Array.isArray(body?.categories) ? body.categories : [];

    if (!filePath) throw new Error("Missing filePath");

    /* ================= STORAGE PATH FIX ================= */
    if (filePath.startsWith("receipts/")) {
      filePath = filePath.replace("receipts/", "");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    /* ================= DOWNLOAD RECEIPT ================= */
    const { data: fileBlob, error: dlErr } = await supabase
      .storage
      .from("receipts")
      .download(filePath);

    if (dlErr || !fileBlob) {
      console.error("Storage error:", dlErr);
      throw new Error("Failed to download receipt");
    }

    const base64 = await blobToBase64(fileBlob);

    /* ================= OCR ================= */
    const ocrText = await openaiVisionOCR(base64);
    const parsed = extractJsonObject(ocrText);

    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error("OCR did not return valid JSON");
    }

    const cleanedItems = parsed.items
      .map((x: any) => ({
        name: String(x?.name || "").trim(),
        amount: Number(x?.amount),
        code: x?.code || null,
      }))
      .filter((x: any) => isValidProductLine(x.name, x.amount));

    const taxAmount = Number(parsed.tax || 0) || 0;

    /* ================= ENRICH ================= */
    const enriched = await Promise.all(
      cleanedItems.map(async (item: any) => {
        const raw = item.name;
        const amount = Number(item.amount) || 0;

        const codeNormalized = normalizeCode(item.code);

        let normalizedName = "";

        if (codeNormalized) {
          const { data: mem } = await supabase
            .from("product_match_memory")
            .select("product_name")
            .eq("product_code", codeNormalized)
            .maybeSingle();

          if (mem?.product_name) normalizedName = mem.product_name;
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
          normalized_description: normalizedName,
          amount,
          suggested_category: suggestedCategory,
          product_code: codeNormalized,
        };
      })
    );

    return new Response(
      JSON.stringify({
        line_items: enriched,
        tax_amount: taxAmount,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    console.error("analyze-receipt error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown error" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/* ================= HELPERS ================= */

async function safeJson(req: Request) {
  const txt = await req.text();
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function extractJsonObject(text: string) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function isValidProductLine(name: string, amount: number) {
  if (!name || !amount || amount <= 0) return false;
  const blacklist = ["subtotal", "total", "tax", "discount", "coupon", "change"];
  return !blacklist.some((word) => name.toLowerCase().includes(word));
}

function normalizeCode(code: string | null) {
  if (!code) return null;
  return code.replace(/^0+/, "");
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
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
              text: `Extract purchasable line items. Return JSON with items[] and tax.`,
            },
            { type: "input_image", image_url: `data:image/png;base64,${base64}` },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data?.output?.[0]?.content?.[0]?.text || "";
}

async function cleanNameOneLine(name: string) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: `Clean this product name. Return only the product name, one line: ${name}`,
    }),
  });

  const data = await res.json();
  return data?.output?.[0]?.content?.[0]?.text?.trim() || name;
}

async function suggestCategory(name: string, categories: string[]) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: `
Choose the best category from this list:
${categories.join(", ")}

Item: ${name}

Return ONLY the category name.
      `,
    }),
  });

  const data = await res.json();
  return data?.output?.[0]?.content?.[0]?.text?.trim() || "Needs Review";
}
