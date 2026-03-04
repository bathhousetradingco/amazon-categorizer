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
};

type SyncContext = {
  plaidBase: string;
  plaidClientId: string;
  plaidSecret: string;
  supabase: any;
  account: SyncAccount;
};

function toTransactionRow(transaction: any, account: SyncAccount) {
  return {
    user_id: account.user_id,
    item_id: account.item_id,
    account_id: transaction.account_id ?? null,
    plaid_transaction_id: transaction.transaction_id,
    date: transaction.date,
    amount: transaction.amount,
    name: transaction.name,
    merchant_name: transaction.merchant_name,
    pending: transaction.pending,
    category: transaction.category?.[0] ?? null,
  };
}

export async function syncPlaidTransactionsForAccount(context: SyncContext): Promise<SyncResult> {
  const { plaidBase, plaidClientId, plaidSecret, supabase, account } = context;

  if (!account.user_id) {
    console.error("❌ Cannot sync Plaid transactions without user_id", {
      item_id: account.item_id,
      account_id: account.id,
    });

    return { upserted: 0, removed: 0, finalCursor: account.cursor };
  }

  let hasMore = true;
  let cursor = account.cursor;
  let totalUpserted = 0;
  let totalRemoved = 0;

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
      console.error("❌ Plaid sync failed", {
        item_id: account.item_id,
        status: plaidRes.status,
        plaid_error: plaidData,
      });
      break;
    }

    const rows = [...(plaidData.added ?? []), ...(plaidData.modified ?? [])]
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
  }

  return { upserted: totalUpserted, removed: totalRemoved, finalCursor: cursor };
}
