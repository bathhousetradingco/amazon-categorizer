import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ensurePlaidItemWebhook } from "../_shared/plaid-webhook.ts";
import { syncPlaidTransactionsForAccount } from "../_shared/plaid-sync.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";

const PLAID_BASE =
  PLAID_ENV === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";

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

Deno.serve(async (req) => {
  const corsHeaders = cors(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const { public_token } = await req.json();
    if (!public_token) {
      return new Response(JSON.stringify({ error: "Missing public_token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const exchangeRes = await fetch(`${PLAID_BASE}/item/public_token/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        public_token,
      }),
    });

    const exchangeData = await exchangeRes.json();
    if (!exchangeRes.ok) {
      return new Response(JSON.stringify(exchangeData), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const access_token = exchangeData.access_token;
    const item_id = exchangeData.item_id;

    // Try to get institution name
    let institution_name: string | null = null;
    try {
      const itemRes = await fetch(`${PLAID_BASE}/item/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: PLAID_CLIENT_ID,
          secret: PLAID_SECRET,
          access_token,
        }),
      });
      const itemData = await itemRes.json();
      if (itemRes.ok && itemData?.item?.institution_id) {
        const instRes = await fetch(`${PLAID_BASE}/institutions/get_by_id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: PLAID_CLIENT_ID,
            secret: PLAID_SECRET,
            institution_id: itemData.item.institution_id,
            country_codes: ["US"],
          }),
        });
        const instData = await instRes.json();
        if (instRes.ok) institution_name = instData?.institution?.name || null;
      }
    } catch {
      // non-fatal
    }

    const { data: existingAccount, error: existingError } = await supabase
      .from("plaid_accounts")
      .select("id, cursor")
      .eq("item_id", item_id)
      .maybeSingle();

    if (existingError) throw existingError;

    let syncedAccountId = existingAccount?.id as string | undefined;
    let syncedCursor = existingAccount?.cursor ?? null;

    if (existingAccount) {
      const { error: updateError } = await supabase
        .from("plaid_accounts")
        .update({
          user_id: user.id,
          access_token,
          institution: institution_name,
        })
        .eq("id", existingAccount.id);

      if (updateError) throw updateError;
    } else {
      const { data: insertedAccount, error: insertError } = await supabase
        .from("plaid_accounts")
        .insert({
          user_id: user.id,
          item_id,
          access_token,
          cursor: null,
          institution: institution_name,
        })
        .select("id, cursor")
        .single();

      if (insertError) throw insertError;

      syncedAccountId = insertedAccount.id;
      syncedCursor = insertedAccount.cursor;
    }

    if (!syncedAccountId) {
      throw new Error("Unable to resolve plaid account row");
    }

    let webhookUpdated = false;
    let webhookError: string | null = null;
    try {
      const webhookResult = await ensurePlaidItemWebhook({
        plaidBase: PLAID_BASE,
        plaidClientId: PLAID_CLIENT_ID,
        plaidSecret: PLAID_SECRET,
        supabaseUrl: SUPABASE_URL,
        accessToken: access_token,
      });
      webhookUpdated = webhookResult.updated;
    } catch (err: any) {
      webhookError = err?.message || "Webhook repair failed";
      console.error("❌ Failed to repair Plaid webhook during token exchange", {
        item_id,
        error: webhookError,
      });
    }

    const syncResult = await syncPlaidTransactionsForAccount({
      plaidBase: PLAID_BASE,
      plaidClientId: PLAID_CLIENT_ID,
      plaidSecret: PLAID_SECRET,
      supabase,
      account: {
        id: syncedAccountId,
        user_id: user.id,
        item_id,
        access_token,
        cursor: syncedCursor,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        item_id,
        institution: institution_name,
        webhook_updated: webhookUpdated,
        webhook_error: webhookError,
        imported: syncResult.upserted,
        removed: syncResult.removed,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
