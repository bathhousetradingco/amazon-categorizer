import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncPlaidTransactionsForAccount } from "../_shared/plaid-sync.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";

const PLAID_BASE = PLAID_ENV === "production"
  ? "https://production.plaid.com"
  : "https://sandbox.plaid.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // TODO(security): verify webhook authenticity using Plaid signature headers when enabled.

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await req.json().catch(() => ({}));

    const webhookType = body?.webhook_type;
    const webhookCode = body?.webhook_code;
    const itemId = body?.item_id;
    console.log("📩 PLAID WEBHOOK", {
      webhook_type: webhookType,
      webhook_code: webhookCode,
      item_id: itemId,
    });

    if (!itemId) {
      console.error("⚠️ Missing item_id in webhook payload");
      return new Response("ok", { headers: corsHeaders });
    }

    const { data: plaidAccount, error: accountError } = await supabase
      .from("plaid_accounts")
      .select("id, user_id, item_id, access_token, cursor")
      .eq("item_id", itemId)
      .limit(1)
      .maybeSingle();

    if (accountError || !plaidAccount?.access_token) {
      console.error("❌ Unable to resolve plaid account for webhook", {
        item_id: itemId,
        error: accountError,
      });
      return new Response("ok", { headers: corsHeaders });
    }

    if (!plaidAccount.user_id) {
      console.error("❌ Skipping webhook sync due to missing user_id", {
        item_id: itemId,
        plaid_account_id: plaidAccount.id,
      });
      return new Response("ok", { headers: corsHeaders });
    }

    if (
      webhookType === "TRANSACTIONS" &&
      [
        // /transactions/sync webhook
        "SYNC_UPDATES_AVAILABLE",
        // legacy /transactions/get webhooks (kept for compatibility)
        "INITIAL_UPDATE",
        "HISTORICAL_UPDATE",
        "DEFAULT_UPDATE",
      ].includes(webhookCode)
    ) {
      const result = await syncPlaidTransactionsForAccount({
        plaidBase: PLAID_BASE,
        plaidClientId: PLAID_CLIENT_ID,
        plaidSecret: PLAID_SECRET,
        supabase,
        account: plaidAccount,
      });

      console.log("✅ Webhook sync complete", {
        item_id: itemId,
        upserted: result.upserted,
        removed: result.removed,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("❌ Plaid webhook handler error", err);

    return new Response(
      JSON.stringify({ error: err?.message || "Webhook failed" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
