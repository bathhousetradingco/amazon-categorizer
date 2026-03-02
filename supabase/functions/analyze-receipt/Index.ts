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
    const filePath = body?.filePath;
    const categories: string[] = Array.isArray(body?.categories) ? body.categories : [];

    if (!filePath) throw new Error("Missing filePath");

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    /* ================= DOWNLOAD RECEIPT ================= */
    const { data: fileBlob, error: dlErr } = await supabase
      .storage
      .from("receipts")
      .download(filePath);

    if (dlErr || !fileBlob) throw new Error("Download failed");

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

        // Prefer explicit code field; otherwise extract from text
        const codeFromText = extractProductCode(raw);
        const codeRaw = item.code || codeFromText?.raw || null;
        const codeNormalized = normalizeCode(codeRaw);

        // 1) MEMORY lookup by normalized code
        let normalizedName = "";

        if (codeNormalized) {
          const { data: mem } = await supabase
            .from("product_match_memory")
            .select("product_name")
            .eq("product_code", codeNormalized)
            .maybeSingle();

          if (mem?.product_name) normalizedName = String(mem.product_name);
        }

        // 2) AI clean name (STRICT, one line only)
        if (!normalizedName) {
          normalizedName = await cleanNameOneLine(raw);
        }

        // 3) Category suggestion (optional)
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
    return new Response(JSON.stringify({ error: err?.message || "Unknown error" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/* ================= HELPERS ================= */

async function safeJson(req: Request) {
  // prevents: Unexpected end of JSON input
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
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
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
- EXCLUDE "pricing math" lines like "36 AT 1 FOR 8.98" or "2 AT 1 FOR 30.98" (those are NOT products).
- If a product code/UPC/SKU appears on the same line as an item, include it as "code".

Return JSON ONLY in this exact format:
{
  "items": [
    { "name": "…", "amount": 0.00, "code": "optional" }
  ],
  "tax": 0.00
}
              `.trim(),
            },
            { type: "input_image", image_url: `data:image/png;base64,${base64}` },
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

function extractJsonObject(text: string): any | null {
  // strips ```json blocks and grabs first {...} safely
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function isValidProductLine(name: string, amount: number): boolean {
  if (!name || typeof name !== "string") return false;
  if (!amount || isNaN(amount) || amount <= 0) return false;

  const n = name.trim().toLowerCase();

  // must contain at least one letter (prevents pure numeric garbage)
  if (!/[a-z]/i.test(name)) return false;

  // kill summary/non-item lines
  const badWords = [
    "subtotal",
    "total",
    "tax",
    "tender",
    "change",
    "balance",
    "instant savings",
    "savings",
    "discount",
    "coupon",
    "member",
    "mastercard",
    "visa",
    "amex",
    "debit",
    "credit",
    "cash",
    "items sold",
  ];
  if (badWords.some((w) => n.includes(w))) return false;

  // kill Sam's/Walmart style math lines: "36 AT 1 FOR 8.98" / "2 AT 1 FOR 30.98"
  // these are NEVER products
  if (/\b\d+\s+at\s+\d+\s+for\s+\$?\d+(\.\d{2})?\b/i.test(n)) return false;
  if (/^\s*\d+\s+at\b/i.test(n)) return false;

  return true;
}

function extractProductCode(line: string): { raw: string; normalized: string } | null {
  const m = line.match(/\b\d{5,15}\b/);
  if (!m) return null;
  const raw = m[0];
  const normalized = normalizeCode(raw);
  return { raw, normalized: normalized || raw };
}

function normalizeCode(codeRaw: string | null): string | null {
  if (!codeRaw) return null;
  const digits = String(codeRaw).replace(/[^\d]/g, "");
  if (digits.length < 5) return null;

  // remove leading zeros (Sam’s especially)
  const normalized = digits.replace(/^0+/, "") || digits;
  return normalized;
}

async function cleanNameOneLine(raw: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You are a receipt item normalizer. Output ONLY the cleaned product name. No explanations. One line only.",
        },
        {
          role: "user",
          content: `Clean this receipt item name into a short product name (2–8 words max, <=60 chars). Remove quantities/pricing math.\n\nRAW: ${raw}`,
        },
      ],
    }),
  });

  const data = await res.json();
  let out = String(data?.output?.[0]?.content?.[0]?.text || "").trim();

  // hard stop: if model still rambles, take first line and clip
  out = out.split("\n")[0].trim();
  out = out.replace(/^"+|"+$/g, ""); // trim quotes
  if (out.length > 60) out = out.slice(0, 60).trim();

  // fallback
  if (!out) return raw;
  return out;
}

async function suggestCategory(itemName: string, categories: string[]): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "Return ONLY a category name from the provided list. No other text.",
        },
        {
          role: "user",
          content: `Categories: ${categories.join(", ")}\nItem: ${itemName}\nReturn ONLY the best category name.`,
        },
      ],
    }),
  });

  const data = await res.json();
  let out = String(data?.output?.[0]?.content?.[0]?.text || "").trim();
  out = out.split("\n")[0].trim();

  // ensure it is one of the categories; otherwise Needs Review
  if (!categories.includes(out)) return "Needs Review";
  return out;
}