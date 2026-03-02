import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

/* ================= CORS ================= */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      console.log("⚠️ No JSON body");
    }

    console.log("📩 PLAID WEBHOOK:", JSON.stringify(body));

    const webhook_type = body?.webhook_type;
    const webhook_code = body?.webhook_code;
    const item_id = body?.item_id;

    if (!item_id) {
      console.log("⚠️ Missing item_id");
      return new Response("ok", { headers: corsHeaders });
    }

    /* ================= GET ACCOUNT ================= */
    const { data: account, error } = await supabase
      .from("plaid_accounts")
      .select("access_token, cursor")
      .eq("item_id", item_id)
      .maybeSingle();

    if (error || !account?.access_token) {
      console.log("❌ No account found for item:", item_id);
      return new Response("ok", { headers: corsHeaders });
    }

    /* ================= HANDLE EVENTS ================= */
    if (
      webhook_type === "TRANSACTIONS" &&
      ["INITIAL_UPDATE", "HISTORICAL_UPDATE", "DEFAULT_UPDATE"].includes(webhook_code)
    ) {
      console.log("🔄 TRANSACTION SYNC TRIGGERED");

      await syncTransactions({
        access_token: account.access_token,
        cursor: account.cursor,
        item_id,
        supabase,
      });
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("❌ WEBHOOK ERROR:", err);

    return new Response(
      JSON.stringify({ error: err?.message || "Webhook failed" }),
      {
        status: 200, // MUST be 200 for Plaid
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/* ================= SYNC ================= */

async function syncTransactions({
  access_token,
  cursor,
  item_id,
  supabase,
}: any) {
  try {
    console.log("🚀 Starting sync for item:", item_id);

    let hasMore = true;
    let nextCursor = cursor;

    while (hasMore) {
      const res = await fetch(`${PLAID_BASE}/transactions/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: PLAID_CLIENT_ID,
          secret: PLAID_SECRET,
          access_token,
          cursor: nextCursor,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        console.log("❌ Plaid error:", data);
        break;
      }

      console.log("📦 Added:", data.added?.length || 0);
      console.log("✏️ Modified:", data.modified?.length || 0);
      console.log("🗑️ Removed:", data.removed?.length || 0);

      /* ================= UPSERT (added + modified) ================= */
      const upserts = [...(data.added || []), ...(data.modified || [])].map((t: any) => ({
        plaid_transaction_id: t.transaction_id,
        item_id,
        name: t.name,
        amount: t.amount,
        date: t.date,
        merchant_name: t.merchant_name,
        category: t.category?.[0] || null,
        pending: t.pending,
      }));

      if (upserts.length > 0) {
        const { error } = await supabase
          .from("transactions")
          .upsert(upserts, { onConflict: "plaid_transaction_id" });

        if (error) {
          console.log("❌ Insert error:", error);
        } else {
          console.log("✅ Saved:", upserts.length);
        }
      }

      /* ================= DELETE REMOVED ================= */
      const removedIds = (data.removed || []).map((r: any) => r.transaction_id);

      if (removedIds.length > 0) {
        const { error } = await supabase
          .from("transactions")
          .delete()
          .in("plaid_transaction_id", removedIds);

        if (error) {
          console.log("❌ Delete error:", error);
        } else {
          console.log("🗑️ Removed:", removedIds.length);
        }
      }

      nextCursor = data.next_cursor;
      hasMore = data.has_more;
    }

    /* ================= SAVE CURSOR ================= */
    await supabase
      .from("plaid_accounts")
      .update({ cursor: nextCursor })
      .eq("item_id", item_id);

    console.log("✅ Sync complete. Cursor saved.");

  } catch (err) {
    console.log("❌ Sync failed:", err);
  }
}