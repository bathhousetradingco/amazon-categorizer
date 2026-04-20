import { fetchWithTimeout } from "./fetch.ts";

type SyncAccount = {
  id: string;
  user_id: string | null;
  item_id: string;
  access_token: string;
  cursor: string | null;
};

type SyncResult = {
  upserted: number;
  removed: number;
  finalCursor: string | null;
  errors: Array<{
    phase: "plaid_sync" | "upsert" | "delete" | "cursor_update";
    message: string;
  }>;
};

type SyncContext = {
  plaidBase: string;
  plaidClientId: string;
  plaidSecret: string;
  supabase: any;
  account: SyncAccount;
};

function normalizeText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isExcludedPlaidTransaction(transaction: any): boolean {
  const amount = Number(transaction?.amount);
  if (!Number.isFinite(amount)) return true;

  // Only keep debit/outflow transactions.
  if (amount <= 0) return true;

  const topCategory = normalizeText(transaction?.personal_finance_category?.primary) ||
    normalizeText(transaction?.category?.[0]);
  const detailCategory = normalizeText(transaction?.personal_finance_category?.detailed) ||
    normalizeText(transaction?.category?.[1]);
  const name = normalizeText(transaction?.name);
  const merchant = normalizeText(transaction?.merchant_name);
  const combined = `${name} ${merchant}`.trim();

  if (
    topCategory.includes("transfer") ||
    topCategory.includes("loan") ||
    topCategory.includes("bank fees") ||
    detailCategory.includes("transfer") ||
    detailCategory.includes("loan") ||
    detailCategory.includes("credit card payment")
  ) {
    return true;
  }

  const excludedPatterns = [
    "transfer",
    "payment thank you",
    "credit card payment",
    "capital one",
    "autopay",
    "ach payment",
    "online payment",
    "mobile banking transfer",
    "internet banking transfer",
    "electronic withdrawal",
  ];

  return excludedPatterns.some((pattern) => combined.includes(pattern));
}

function toTransactionRow(transaction: any, account: SyncAccount) {
  return {
    user_id: account.user_id,
    item_id: account.item_id,
    plaid_transaction_id: transaction.transaction_id,
    date: transaction.date,
    amount: transaction.amount,
    name: transaction.name,
    merchant_name: transaction.merchant_name,
    pending: transaction.pending,
    category: transaction.category?.[0] ?? null,
  };
}

function plaidErrorSummary(payload: any) {
  const source = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  return {
    error_type: source?.error_type || null,
    error_code: source?.error_code || null,
    error_message: source?.error_message || source?.display_message || null,
    request_id: source?.request_id || payload?.request_id || null,
  };
}

export async function syncPlaidTransactionsForAccount(context: SyncContext): Promise<SyncResult> {
  const { plaidBase, plaidClientId, plaidSecret, supabase, account } = context;

  if (!account.user_id) {
    console.error("❌ Cannot sync Plaid transactions without user_id", {
      item_id: account.item_id,
      account_id: account.id,
    });

    return { upserted: 0, removed: 0, finalCursor: account.cursor, errors: [] };
  }

  let hasMore = true;
  let cursor = account.cursor;
  let totalUpserted = 0;
  let totalRemoved = 0;
  const errors: SyncResult["errors"] = [];

  while (hasMore) {
    const plaidRes = await fetchWithTimeout(`${plaidBase}/transactions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: plaidClientId,
        secret: plaidSecret,
        access_token: account.access_token,
        cursor,
      }),
    });

    const plaidData = await plaidRes.json();

    if (!plaidRes.ok || plaidData.error) {
      const summary = plaidErrorSummary(plaidData);
      const message = JSON.stringify(summary);
      console.error("❌ Plaid sync failed", {
        item_id: account.item_id,
        status: plaidRes.status,
        plaid_error: summary,
      });
      errors.push({
        phase: "plaid_sync",
        message,
      });
      break;
    }

    const rows = [...(plaidData.added ?? []), ...(plaidData.modified ?? [])]
      .filter((transaction: any) => !isExcludedPlaidTransaction(transaction))
      .map((transaction: any) => toTransactionRow(transaction, account))
      .filter((row: any) => !!row.user_id && !!row.plaid_transaction_id);

    if (rows.length > 0) {
      const { error: upsertError } = await supabase
        .from("transactions")
        .upsert(rows, { onConflict: "plaid_transaction_id" });

      if (upsertError) {
        console.error("❌ Transaction upsert failed", {
          item_id: account.item_id,
          error: upsertError,
        });
        errors.push({
          phase: "upsert",
          message: upsertError.message || JSON.stringify(upsertError),
        });
      } else {
        totalUpserted += rows.length;
      }
    }

    const removedIds = (plaidData.removed ?? [])
      .map((removed: any) => removed.transaction_id)
      .filter(Boolean);

    if (removedIds.length > 0) {
      const { error: deleteError } = await supabase
        .from("transactions")
        .delete()
        .in("plaid_transaction_id", removedIds)
        .eq("user_id", account.user_id);

      if (deleteError) {
        console.error("❌ Removed transaction delete failed", {
          item_id: account.item_id,
          error: deleteError,
        });
        errors.push({
          phase: "delete",
          message: deleteError.message || JSON.stringify(deleteError),
        });
      } else {
        totalRemoved += removedIds.length;
      }
    }

    hasMore = plaidData.has_more;
    cursor = plaidData.next_cursor;
  }

  const { error: cursorError } = await supabase
    .from("plaid_accounts")
    .update({ cursor })
    .eq("id", account.id);

  if (cursorError) {
    console.error("❌ Failed to save Plaid cursor", {
      account_id: account.id,
      item_id: account.item_id,
      error: cursorError,
    });
    errors.push({
      phase: "cursor_update",
      message: cursorError.message || JSON.stringify(cursorError),
    });
  }

  return { upserted: totalUpserted, removed: totalRemoved, finalCursor: cursor, errors };
}
