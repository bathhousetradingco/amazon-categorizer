import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ==============================
   ENV
============================== */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_KEY = Deno.env.get("OPENAI_KEY")!;

/* ==============================
   CORS
============================== */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ==============================
   MAIN
============================== */
Deno.serve(async (req) => {
  console.log("ANALYZE RECEIPT VERSION TEST-002");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    /* ==============================
       AUTH
    ============================== */
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonError("Missing Authorization header", 401);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return jsonError("Invalid or expired session", 401);
    }

    /* ==============================
       BODY
    ============================== */
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const filePath = body?.filePath;
    const categories = Array.isArray(body?.categories)
      ? body.categories
      : [];

    if (!filePath) {
      return jsonError("Missing filePath", 400);
    }

    /* ==============================
       DOWNLOAD RECEIPT
    ============================== */
    const { data: fileData, error: downloadError } =
      await supabase.storage.from("receipts").download(filePath);

    if (downloadError || !fileData) {
      return jsonError("Unable to download receipt", 400);
    }

    const text = await fileData.text();
    if (!text || text.length < 10) {
      return jsonError("Receipt text empty or unreadable", 400);
    }

    /* ==============================
       CALL OPENAI
    ============================== */
    const aiRes = await fetch("https://api.openai.com/v1/responses", {
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
              "Extract line items from receipt text. Return JSON with items array.",
          },
          {
            role: "user",
            content: text,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      return jsonError("AI request failed", 500);
    }

    const aiData = await aiRes.json();

    let rawOutput = "";
    try {
      rawOutput = aiData.output?.[0]?.content?.[0]?.text ?? "";
    } catch {
      return jsonError("Unexpected AI response format", 500);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      return jsonError("AI returned invalid JSON", 500);
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    /* ==============================
       NORMALIZE ITEMS
    ============================== */
    const normalizedItems = items.map((item: any) => ({
      name: String(item?.name ?? "").trim(),
      quantity: Number(item?.quantity ?? 1),
      price: Number(item?.price ?? 0),
      normalized_description: normalizeDescription(item?.name ?? ""),
      suggested_category: null,
    }));

    /* ==============================
       OPTIONAL CATEGORY SUGGESTION
    ============================== */
    if (categories.length > 0) {
      for (const item of normalizedItems) {
        item.suggested_category = suggestCategory(
          item.normalized_description,
          categories
        );
      }
    }

    /* ==============================
       SUCCESS RESPONSE
    ============================== */
    return new Response(
      JSON.stringify({
        success: true,
        items: normalizedItems,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (err: any) {
    console.error("Unhandled error:", err);
    return jsonError("Unexpected server error", 500);
  }
});

/* ==============================
   HELPERS
============================== */

function normalizeDescription(text: string) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim();
}

function suggestCategory(itemName: string, categories: string[]) {
  for (const cat of categories) {
    if (itemName.includes(cat.toLowerCase())) {
      return cat;
    }
  }
  return null;
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}
