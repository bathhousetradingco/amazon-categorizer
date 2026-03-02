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
  console.log("ANALYZE RECEIPT VERSION TEST-001");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await safeJson(req);
    const filePath = body?.filePath;
    const categories: string[] = Array.isArray(body?.categories) ? body.categories : [];

    if (!filePath) throw new Error("Missing filePath");
    if (!Array.isArray(body?.categories)) throw new Error("Missing categories array");

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    /* ================= DOWNLOAD RECEIPT ================= */
    const { data: fileBlob, error: dlErr } = await supabase
      .storage
      .from("receipts")
      .download(filePath);

    if (dlErr || !fileBlob) throw new Error("Download failed");
    if (fileBlob.size === 0) throw new Error("Downloaded file is empty");

    const base64 = await blobToBase64(fileBlob);

    /* ================= OCR TEXT ================= */
    const ocrText = await openaiVisionOCR(base64);
    console.log("Raw OCR text length:", ocrText.length);

    /* ================= STAGE 1: STRUCTURED EXTRACTION ================= */
    const structured = parseReceiptStructured(ocrText);
    console.log("Number of parsed items:", structured.items.length);

    // Backward-compatible fallback if OCR happened to return legacy JSON
    if (!structured.items.length) {
      const parsed = extractJsonObject(ocrText);
      if (parsed && Array.isArray(parsed.items)) {
        structured.items = parsed.items
          .map((x: any) => ({
            item_number: null,
            raw_line: typeof x?.name === "string" ? x.name.trim() : "",
            description: typeof x?.name === "string" ? x.name.trim() : "",
            quantity: null,
            unit_price: null,
            total_price: Number(x?.amount),
            code: typeof x?.code === "string" ? x.code.trim() : null,
            uncertain: true,
          }))
          .filter((x: any) => isValidProductLine(x.description, x.total_price));

        structured.tax = Number(parsed.tax || 0) || 0;
      }
    }

    if (!structured.items.length) {
      return new Response(
        JSON.stringify({
          error: "No valid line items detected"
        }),
        { status: 400 }
      );
    }

    /* ================= STAGE 2: CONTROLLED AI REFINEMENT ================= */
    const refinedDescriptions = await refineStructuredItemsWithAI(structured.items);

    /* ================= POST-FILTER (kill non-products) ================= */
    const postFilteredItems = structured.items
      .map((item, idx) => ({
        name: String(refinedDescriptions[idx] || item.description || item.raw_line).trim(),
        amount: Number(item.total_price),
        code: item.code || null,
      }))
      .filter((x: any) => isValidProductLine(x.name, x.amount));

    const parsedTaxAmount = Number(structured.tax || 0);

    /* ================= ENRICH + NORMALIZE ================= */
    const enrichedItems = await Promise.all(
      postFilteredItems.map(async (item: any) => {
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
          raw_description: cleanDescription(raw),
          normalized_description: cleanDescription(normalizedName || raw),
          amount,
          suggested_category: suggestedCategory || "Needs Review",
        };
      }),
    );

    const cleanedItems = Array.isArray(enrichedItems)
      ? enrichedItems
        .map((item) => ({
          raw_description: cleanDescription(item.raw_description),
          normalized_description: cleanDescription(item.normalized_description),
          amount: Number(item.amount),
          suggested_category: cleanDescription(item.suggested_category || "Needs Review"),
        }))
        .filter((item) => isValidProductLine(item.normalized_description, item.amount))
      : [];

    console.log("Final cleaned item count:", cleanedItems.length);

    if (!cleanedItems.length) {
      return new Response(
        JSON.stringify({
          error: "No valid line items detected"
        }),
        { status: 400 }
      );
    }

    const taxAmount = Number.isFinite(parsedTaxAmount) ? parsedTaxAmount : 0;

    return new Response(
      JSON.stringify({
        line_items: cleanedItems,
        tax_amount: taxAmount
      }),
      { headers: { "Content-Type": "application/json" } }
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
Transcribe this receipt to plain text with one receipt line per output line.
Preserve item lines and numeric values exactly as seen.
Do not summarize.
If uncertain on a character, keep best guess but preserve line structure.
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

type StructuredItem = {
  item_number: string | null;
  raw_line: string;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number;
  code: string | null;
  uncertain: boolean;
};

function parseReceiptStructured(ocrText: string): { items: StructuredItem[]; tax: number } {
  const lines = ocrText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const items: StructuredItem[] = [];
  let tax = 0;

  for (const line of lines) {
    const upper = line.toUpperCase();

    // tax capture for response field
    if (/\bTAX\b/.test(upper)) {
      const price = extractTrailingPrice(line);
      if (price !== null) tax = Math.max(tax, price);
    }

    if (isNoiseLine(line)) continue;

    const parsed = parseCandidateLine(line);
    if (!parsed) continue;

    items.push(parsed);
  }

  return { items, tax };
}

function isNoiseLine(line: string): boolean {
  const upper = line.toUpperCase();

  const noiseTerms = [
    "SUBTOTAL",
    "TOTAL",
    "TAX",
    "CHANGE",
    "CASH",
    "CARD",
    "VISA",
    "MASTERCARD",
    "APPROVED",
    "AUTH",
    "STORE #",
    "DATE",
    "TIME",
    "THANK YOU",
    "PAYMENT",
    "BALANCE",
    "TENDER",
  ];
  if (noiseTerms.some((x) => upper.includes(x))) return true;

  // addresses / phone / barcode / long numeric ids / loyalty-like lines
  if (/\b\d{1,5}\s+[A-Z0-9 .'-]+\s(?:ST|AVE|RD|DR|BLVD|LN|HWY)\b/i.test(line)) return true;
  if (/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) return true;
  if (/^\d{12,}$/.test(line.replace(/\s+/g, ""))) return true;
  if (/\b(LOYALTY|MEMBER|ID#?|ACCOUNT)\b/i.test(line) && /\d{6,}/.test(line)) return true;
  if (/\*{4,}|\|{3,}/.test(line)) return true;

  return false;
}

function parseCandidateLine(line: string): StructuredItem | null {
  const qtyAt = line.match(/\b(\d+(?:\.\d+)?)\s*@\s*(\d+\.\d{2})\b/i);
  const trailingPrice = extractTrailingPrice(line);
  const hasPriceTaxIndicator = /\d+\.\d{2}\s+[A-Z]{1,3}$/.test(line);

  if (!qtyAt && trailingPrice === null && !hasPriceTaxIndicator) return null;

  const itemNumberMatch = line.match(/^\s*(\d{3,14})\s+(.+)$/);
  const item_number = itemNumberMatch ? itemNumberMatch[1] : null;
  let rest = itemNumberMatch ? itemNumberMatch[2] : line;

  let quantity: number | null = null;
  let unit_price: number | null = null;
  if (qtyAt) {
    quantity = Number(qtyAt[1]);
    unit_price = Number(qtyAt[2]);
    rest = rest.replace(qtyAt[0], " ").trim();
  }

  const total_price = qtyAt ? Number((quantity! * unit_price!).toFixed(2)) : trailingPrice;
  if (total_price === null || total_price <= 0) return null;

  let description = rest
    .replace(/\b\d+\.\d{2}\s*[A-Z]{0,3}\s*$/i, "")
    .replace(/\$\s*\d+\.\d{2}\s*$/i, "")
    .replace(/\d+\.\d{2}\s*$/i, "")
    .trim();

  if (!description || !/[a-z]/i.test(description)) return null;

  const codeFromText = extractProductCode(line);

  return {
    item_number,
    raw_line: line,
    description,
    quantity,
    unit_price,
    total_price,
    code: codeFromText?.raw || null,
    uncertain: description.length < 3 || /\bITEM\b|\bMISC\b|\bUNKNOWN\b/i.test(description),
  };
}

function extractTrailingPrice(line: string): number | null {
  const m = line.match(/(?:\$\s*)?(\d+\.\d{2})(?:\s+[A-Z]{1,3})?\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function refineStructuredItemsWithAI(items: StructuredItem[]): Promise<string[]> {
  const candidates = items.map((item, index) => ({
    index,
    item_number: item.item_number,
    description: item.description,
    uncertain: item.uncertain,
  }));

  const needRefine = candidates.filter((x) => x.uncertain || x.description.length > 60);
  if (!needRefine.length) {
    return items.map((x) => x.description);
  }

  try {
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
              "You are a receipt line item normalizer. You clean product descriptions without inventing data. You never combine items. You never hallucinate. You never add missing products. You return valid JSON only.",
          },
          {
            role: "user",
            content:
              `Return JSON only in this exact shape: {"items":[{"index":0,"item_number":null,"description":""}]}. Rules: Preserve item_number exactly if provided. Do not merge multiple items. Do not invent quantity or prices. If uncertain, return original description unchanged. Do not modify numeric values. Do not reformat prices. Input candidates: ${JSON.stringify(needRefine)}`,
          },
        ],
      }),
    });

    const data = await res.json();
    const txt = String(data?.output?.[0]?.content?.[0]?.text || "");
    const parsed = extractJsonObject(txt);

    const out = items.map((x) => x.description);
    if (!parsed || !Array.isArray(parsed.items)) return out;

    for (const entry of parsed.items) {
      const idx = Number(entry?.index);
      const desc = typeof entry?.description === "string" ? entry.description.trim() : "";
      if (!Number.isInteger(idx) || idx < 0 || idx >= out.length) continue;
      if (desc) out[idx] = desc;
    }
    return out;
  } catch {
    return items.map((x) => x.description);
  }
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


function cleanDescription(input: string): string {
  const cleaned = String(input || "")
    .replace(/\s+/g, " ")
    .replace(/[|`~^<>]+/g, " ")
    .replace(/[\u0000-\u001F]+/g, " ")
    .trim();

  return cleaned;
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
