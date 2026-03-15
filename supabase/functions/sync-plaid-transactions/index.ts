import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ensurePlaidItemWebhook } from "../_shared/plaid-webhook.ts";
import { syncPlaidTransactionsForAccount } from "../_shared/plaid-sync.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";

const PLAID_BASE = PLAID_ENV === "production"
  ? "https://production.plaid.com"
  : "https://sandbox.plaid.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const itemId = body.item_id || null;
    const resetCursor = body.reset_cursor !== false;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    let query = supabase
      .from("plaid_accounts")
      .select("id, user_id, item_id, access_token, cursor")
      .eq("user_id", user.id);

    if (itemId) {
      query = query.eq("item_id", itemId);
    }

    const { data: accounts, error: accountError } = await query;
    if (accountError) throw accountError;

    if (!accounts?.length) {
      return new Response(JSON.stringify({ success: true, inserted: 0, removed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalUpserted = 0;
    let totalRemoved = 0;
    let webhookRepairCount = 0;
    const webhookRepairErrors: Array<{ item_id: string; error: string }> = [];

    for (const account of accounts) {
      const accountToSync = resetCursor
        ? { ...account, cursor: null }
        : account;

      if (resetCursor) {
        const { error: cursorResetError } = await supabase
          .from("plaid_accounts")
          .update({ cursor: null })
          .eq("id", account.id);

        if (cursorResetError) {
          throw cursorResetError;
        }
      }

      try {
        const webhookResult = await ensurePlaidItemWebhook({
          plaidBase: PLAID_BASE,
          plaidClientId: PLAID_CLIENT_ID,
          plaidSecret: PLAID_SECRET,
          supabaseUrl: SUPABASE_URL,
          accessToken: account.access_token,
        });
        if (webhookResult.updated) {
          webhookRepairCount += 1;
        }
      } catch (err: any) {
        const errorMessage = err?.message || "Webhook repair failed";
        webhookRepairErrors.push({ item_id: account.item_id, error: errorMessage });
        console.error("❌ Failed to repair Plaid webhook before sync", {
          item_id: account.item_id,
          error: errorMessage,
        });
      }

      const result = await syncPlaidTransactionsForAccount({
        plaidBase: PLAID_BASE,
        plaidClientId: PLAID_CLIENT_ID,
        plaidSecret: PLAID_SECRET,
        supabase,
        account: accountToSync,
      });

      totalUpserted += result.upserted;
      totalRemoved += result.removed;
    }

    return new Response(
      JSON.stringify({
        success: true,
        inserted: totalUpserted,
        removed: totalRemoved,
        reset_cursor: resetCursor,
        webhook_repairs: webhookRepairCount,
        webhook_repair_errors: webhookRepairErrors,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("❌ Manual Plaid sync failed", err);

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
