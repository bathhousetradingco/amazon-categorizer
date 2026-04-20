import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePlaidWebhookUrl } from "../_shared/plaid-webhook.ts";

/* ================= ENV ================= */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";

const PLAID_BASE =
  PLAID_ENV === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";

/* ================= WEBHOOK ================= */
const WEBHOOK_URL = resolvePlaidWebhookUrl(SUPABASE_URL);

/* ================= CORS ================= */
const ALLOWED_ORIGINS = new Set([
  "https://bathhousetradingco.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5500",
]);

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://bathhousetradingco.github.io",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

/* ================= FUNCTION ================= */
Deno.serve(async (req) => {
  const corsHeaders = cors(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return new Response("Unauthorized", {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return new Response("Unauthorized", {
        status: 401,
        headers: corsHeaders,
      });
    }

    /* ================= PLAID LINK TOKEN ================= */
    const plaidRes = await fetch(`${PLAID_BASE}/link/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        client_name: "Bathhouse Categorizer",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: user.id },
        products: ["transactions"],
        webhook: WEBHOOK_URL, // ✅ FIXED HERE
      }),
    });

    const plaidData = await plaidRes.json();

    if (!plaidRes.ok) {
      console.error("❌ Plaid error:", plaidData);

      return new Response(JSON.stringify(plaidData), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ link_token: plaidData.link_token }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    console.error("❌ LINK TOKEN ERROR:", err);

    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
