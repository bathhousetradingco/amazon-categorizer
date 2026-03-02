import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* =========================
   ENV
========================= */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
    const body = await req.json().catch(() => ({}));
    const itemId = body.item_id || null;
    const manualUserId = body.user_id || null;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (!itemId && !manualUserId) {
      return new Response(
        JSON.stringify({ error: "Missing item_id or user_id" }),
        { status: 400, headers: corsHeaders }
      );
    }

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

    for (const account of accounts) {

      let hasMore = true;
      let cursor = account.cursor;

      const institution =
        account.institution ||
        account.institution_name ||
        "Unknown Bank";

      while (hasMore) {

        const plaidRes = await fetch(`${PLAID_BASE}/transactions/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: PLAID_CLIENT_ID,
            secret: PLAID_SECRET,
            access_token: account.access_token,
            cursor
          }),
        });

        const plaidData = await plaidRes.json();

        if (plaidData.error) {
          console.error("❌ Plaid error:", plaidData.error);
          break;
        }

        const transactions = plaidData.added || [];

        console.log("📦 Pulled:", transactions.length);

        for (const t of transactions) {

          if (!t.date) continue;

          /* =========================
             HARD DATE FILTER (2026+ ONLY)
          ========================= */
          const txnDate = new Date(t.date + "T00:00:00");
          const cutoffDate = new Date("2026-01-01T00:00:00");

          if (txnDate < cutoffDate) {
            console.log("⛔ Skipping pre-2026 txn:", t.date, t.name);
            continue;
          }

          /* =========================
             TRANSFER FILTER (STRONG)
          ========================= */
          const name = (t.name || "").toLowerCase();
          const merchant = (t.merchant_name || "").toLowerCase();
          const primaryCategory =
            (t.personal_finance_category?.primary || "").toLowerCase();

          const isTransfer =
            name.includes("transfer") ||
            name.includes("mobile banking") ||
            name.includes("withdrawal") ||
            name.includes("online transfer") ||
            merchant.includes("transfer") ||
            primaryCategory.includes("transfer");

          if (isTransfer) {
            console.log("⛔ Skipping transfer txn:", t.name);
            continue;
          }

          /* =========================
             SKIP PENDING
          ========================= */
          if (t.pending) continue;

          /* =========================
             DUPLICATE CHECK
          ========================= */
          const startDate = new Date(txnDate);
          startDate.setDate(startDate.getDate() - 3);

          const endDate = new Date(txnDate);
          endDate.setDate(endDate.getDate() + 3);

          const { data: match } = await supabase
            .from("transactions")
            .select("id")
            .gte("date", startDate.toISOString().split("T")[0])
            .lte("date", endDate.toISOString().split("T")[0])
            .eq("amount", t.amount)
            .eq("user_id", account.user_id)
            .limit(1);

          if (match && match.length > 0) {
            console.log("⚠️ Skipping duplicate:", t.name);
            continue;
          }

          /* =========================
             INSERT ROW
          ========================= */
          const row = {
            user_id: account.user_id,
            plaid_id: t.transaction_id,
            account_id: t.account_id,
            date: t.date,
            title: t.name,
            vendor: t.merchant_name || t.name || "Unknown",
            amount: t.amount,
            source: "Plaid",
            institution: institution,
            category: null,
          };

          const { error: insertError } = await supabase
            .from("transactions")
            .upsert(row, { onConflict: "plaid_id" });

          if (insertError) {
            console.log("❌ Insert error:", insertError);
          } else {
            totalInserted++;
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

      console.log("✅ Cursor saved for account:", account.id);
    }

    console.log("🎉 TOTAL INSERTED:", totalInserted);

    return new Response(
      JSON.stringify({ success: true, inserted: totalInserted }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("❌ Sync error:", err);

    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
});