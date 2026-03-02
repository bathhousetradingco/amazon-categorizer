import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================
   ENV
========================= */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";

/* =========================
   PLAID BASE
========================= */
const PLAID_BASE =
  PLAID_ENV === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";

/* =========================
   CORS
========================= */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/* =========================
   MAIN HANDLER
========================= */
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
    const manualUserId = user.id;

    if (!itemId && !manualUserId) {
      return new Response(
        JSON.stringify({ error: "Missing item_id or user_id" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    /* =========================
       GET PLAID ACCOUNTS
    ========================= */
    let query = supabase.from("plaid_accounts").select("*");

    if (itemId) {
      query = query.eq("item_id", itemId);
    } else {
      query = query.eq("user_id", manualUserId);
    }

    const { data: accounts, error: accError } = await query;
    if (accError) throw accError;

    if (!accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, inserted: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalInserted = 0;

    /* =========================
       LOOP ACCOUNTS
    ========================= */
    for (const account of accounts) {
      let hasMore = true;
      let cursor = account.cursor;

      while (hasMore) {
        const plaidRes = await fetch(`${PLAID_BASE}/transactions/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: PLAID_CLIENT_ID,
            secret: PLAID_SECRET,
            access_token: account.access_token,
            cursor,
          }),
        });

        const plaidData = await plaidRes.json();

        if (plaidData.error) {
          console.error("Plaid error:", plaidData.error);
          break;
        }

        const transactions = plaidData.added || [];

        for (const t of transactions) {

          /* =========================
             DATE FILTER (2026+)
          ========================= */
          if (!t.date) continue;

          const txnDate = new Date(t.date);
          const cutoffDate = new Date("2026-01-01");

          if (txnDate < cutoffDate) {
            continue;
          }

          /* =========================
             SKIP PENDING
          ========================= */
          if (t.pending) continue;

          /* =========================
             SPECIFIC TRANSFER FILTER
          ========================= */
          const nameLower = (t.name || "").toLowerCase();

          const excludedPatterns = [
            "mobile banking transfer deposit",
            "electronic withdrawal capital one",
            "internet banking transfer deposit"
          ];

          const shouldExclude = excludedPatterns.some(pattern =>
            nameLower.includes(pattern)
          );

          if (shouldExclude) continue;

          /* =========================
             INSERT / UPSERT ROW
          ========================= */
          const row = {
            user_id: account.user_id,
            plaid_transaction_id: t.transaction_id,
            item_id: account.item_id,
            date: t.date,
            amount: t.amount,
            name: t.name,
            merchant_name: t.merchant_name,
            pending: false,
            category: ""
          };

          const { error: insertError } = await supabase
            .from("transactions")
            .upsert(row, {
              onConflict: "plaid_transaction_id"
            });

          if (!insertError) {
            totalInserted++;
          } else {
            console.error("Insert error:", insertError);
          }
        }

        hasMore = plaidData.has_more;
        cursor = plaidData.next_cursor;
      }

      /* =========================
         SAVE CURSOR
      ========================= */
      await supabase
        .from("plaid_accounts")
        .update({ cursor })
        .eq("id", account.id);
    }

    return new Response(
      JSON.stringify({ success: true, inserted: totalInserted }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("Sync error:", err);

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});