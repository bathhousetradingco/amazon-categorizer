import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  fetchAmazonBusinessOrderLineItems,
  getAmazonBusinessConfig,
  type NormalizedAmazonOrderLineItem,
  normalizeAmazonBusinessMarketplaceRegion,
  normalizeAmazonBusinessRegion,
  refreshAmazonBusinessAccessToken,
} from "../_shared/amazon-business.ts";
import { daysAgo, toAmazonBusinessReportDateTime, toIsoDate } from "../_shared/amazon-business-dates.ts";
import { findAmazonPlaidSupersedeMatches } from "../_shared/amazon-business-supersede.ts";
import { corsHeaders, HttpError, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireUser(req);
    const body = await parseJsonBody(req);
    const config = getAmazonBusinessConfig();
    const requestedStart = String(body.start_date || "").trim();
    const requestedEnd = String(body.end_date || "").trim();
    const sandboxDefaults = config.sandbox && !requestedStart && !requestedEnd;
    const orderStartDate = sandboxDefaults
      ? "2025-04-01T00:00:00Z"
      : (toAmazonBusinessReportDateTime(requestedStart, "start") || toAmazonBusinessReportDateTime(daysAgo(120), "start"));
    const orderEndDate = sandboxDefaults
      ? "2025-04-30T00:00:00Z"
      : (toAmazonBusinessReportDateTime(requestedEnd, "end") || toAmazonBusinessReportDateTime(new Date(), "end"));
    if (Date.parse(orderStartDate) > Date.parse(orderEndDate)) {
      throw new HttpError(400, "Amazon Business sync start date must be before the end date");
    }
    const requestedOrderIds = Array.isArray(body.order_ids)
      ? body.order_ids.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const orderIds = requestedOrderIds.length
      ? requestedOrderIds
      : sandboxDefaults
      ? ["112-3456789-0123456"]
      : undefined;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: connection, error: connectionError } = await supabase
      .from("amazon_business_connections")
      .select("id, user_id, region, marketplace_region, refresh_token")
      .eq("user_id", user.id)
      .maybeSingle();

    if (connectionError) throw new HttpError(500, "Failed to load Amazon Business connection", connectionError);
    if (!connection?.refresh_token) throw new HttpError(400, "Amazon Business is not connected");

    const region = normalizeAmazonBusinessRegion(connection.region);
    const marketplaceRegion = normalizeAmazonBusinessMarketplaceRegion(connection.marketplace_region);
    const token = await refreshAmazonBusinessAccessToken({
      refreshToken: connection.refresh_token,
      config,
    });
    const lineItems = await fetchAmazonBusinessOrderLineItems({
      accessToken: token.access_token,
      region,
      marketplaceRegion,
      sandbox: config.sandbox,
      orderStartDate,
      orderEndDate,
      orderIds,
    });

    const rows = lineItems.map((item) => ({
      user_id: user.id,
      order_id: item.order_id,
      line_item_key: item.line_item_key,
      order_date: item.order_date,
      order_status: item.order_status,
      purchase_order_number: item.purchase_order_number,
      asin: item.asin,
      title: item.title,
      seller_name: item.seller_name,
      quantity: item.quantity,
      item_subtotal: item.item_subtotal,
      item_tax: item.item_tax,
      item_total: item.item_total,
      currency: item.currency,
      raw: item.raw,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    let upserted = 0;
    for (const chunk of chunks(rows, 500)) {
      const { error } = await supabase
        .from("amazon_business_order_line_items")
        .upsert(chunk, { onConflict: "user_id,order_id,line_item_key" });

      if (error) throw new HttpError(500, "Failed to store Amazon Business order lines", error);
      upserted += chunk.length;
    }

    const transactionRows = lineItems
      .map((item) => toAmazonBusinessTransactionRow(user.id, item, orderEndDate))
      .filter((row): row is Record<string, unknown> => !!row);
    let transactionRowsUpserted = 0;

    for (const chunk of chunks(transactionRows, 500)) {
      const { error } = await supabase
        .from("transactions")
        .upsert(chunk, { onConflict: "user_id,amazon_business_order_id,amazon_business_line_item_key" });

      if (error) throw new HttpError(500, "Failed to store Amazon Business transaction rows", error);
      transactionRowsUpserted += chunk.length;
    }

    const supersedeResult = await maybeSupersedeAmazonPlaidTransactions(supabase, user.id, lineItems);

    await supabase
      .from("amazon_business_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    return jsonResponse({
      success: true,
      region,
      marketplace_region: marketplaceRegion,
      start_date: orderStartDate,
      end_date: orderEndDate,
      line_items: lineItems.length,
      upserted,
      transaction_rows: transactionRowsUpserted,
      superseded_plaid_rows: supersedeResult.count,
      superseded_plaid_matches: supersedeResult.matches.slice(0, 10),
      preview: lineItems.slice(0, 10).map((item) => ({
        date: toIsoDate(item.order_date || ""),
        title: item.title,
        seller_name: item.seller_name,
        amount: moneyAmount(item),
        order_id: item.order_id,
      })),
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse({
      success: false,
      message: httpError.message,
      details: sanitizeHttpErrorDetails(httpError.details),
    }, httpError.status);
  }
});

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new HttpError(401, "Unauthorized");

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await authClient.auth.getUser();

  if (error || !user) throw new HttpError(401, "Unauthorized");
  return user;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function toAmazonBusinessTransactionRow(
  userId: string,
  item: NormalizedAmazonOrderLineItem,
  fallbackDateTime: string,
): Record<string, unknown> | null {
  const amount = moneyAmount(item);
  if (amount === null) return null;

  const date = toIsoDate(item.order_date || fallbackDateTime) || toIsoDate(new Date());
  const title = item.title || item.asin || `Amazon Business order ${item.order_id}`;

  return {
    user_id: userId,
    date,
    amount,
    name: title,
    merchant_name: item.seller_name || "Amazon Business",
    category: "",
    splits: [],
    pending: false,
    source: "amazon_business",
    source_payload: item.raw,
    amazon_business_order_id: item.order_id,
    amazon_business_line_item_key: item.line_item_key,
    review_status: "",
    deduction_status: "",
    review_note: "Amazon Business order line imported from the Reporting API.",
  };
}

function moneyAmount(item: NormalizedAmazonOrderLineItem): number | null {
  const amount = item.item_total ?? sumMoney(item.item_subtotal, item.item_tax) ?? item.item_subtotal;
  if (!Number.isFinite(Number(amount))) return null;
  return Math.round(Math.abs(Number(amount)) * 100) / 100;
}

function sumMoney(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return Math.round(((left || 0) + (right || 0)) * 100) / 100;
}

async function maybeSupersedeAmazonPlaidTransactions(
  supabase: any,
  userId: string,
  lineItems: NormalizedAmazonOrderLineItem[],
): Promise<{ count: number; matches: Array<Record<string, unknown>> }> {
  const mode = (Deno.env.get("AMAZON_BUSINESS_SUPERSEDE_PLAID_MODE") || "").toLowerCase();
  const legacyBroadEnabled = (Deno.env.get("AMAZON_BUSINESS_SUPERSEDE_PLAID") || "").toLowerCase() === "true";
  if (mode === "off") return { count: 0, matches: [] };
  if (legacyBroadEnabled || mode === "all") {
    return broadSupersedeAmazonPlaidTransactions(supabase, userId);
  }

  const { data: candidates, error: candidateError } = await supabase
    .from("transactions")
    .select("id, date, amount, name, merchant_name")
    .eq("user_id", userId)
    .not("plaid_transaction_id", "is", null)
    .is("superseded_at", null)
    .or("merchant_name.ilike.%amazon%,name.ilike.%amazon%");

  if (candidateError) throw new HttpError(500, "Failed to load Amazon Plaid match candidates", candidateError);

  const matches = findAmazonPlaidSupersedeMatches(candidates || [], lineItems.map((item) => ({
    order_id: item.order_id,
    order_date: item.order_date,
    amount: moneyAmount(item),
  })));
  if (!matches.length) return { count: 0, matches: [] };

  const { data, error } = await supabase
    .from("transactions")
    .update({
      superseded_by_source: "amazon_business",
      superseded_at: new Date().toISOString(),
      review_status: "Superseded by Amazon Business",
      review_note: "Hidden from normal review because Amazon Business order line items matched this Plaid Amazon charge by date and amount.",
    })
    .eq("user_id", userId)
    .in("id", matches.map((match) => match.transaction_id))
    .select("id");

  if (error) throw new HttpError(500, "Failed to supersede matched Amazon Plaid transactions", error);
  return { count: data?.length || 0, matches };
}

async function broadSupersedeAmazonPlaidTransactions(
  supabase: any,
  userId: string,
): Promise<{ count: number; matches: Array<Record<string, unknown>> }> {
  const { data, error } = await supabase
    .from("transactions")
    .update({
      superseded_by_source: "amazon_business",
      superseded_at: new Date().toISOString(),
      review_status: "Superseded by Amazon Business",
      review_note: "Hidden from normal review because Amazon Business line-item rows are now the source of record.",
    })
    .eq("user_id", userId)
    .not("plaid_transaction_id", "is", null)
    .is("superseded_at", null)
    .or("merchant_name.ilike.%amazon%,name.ilike.%amazon%")
    .select("id");

  if (error) throw new HttpError(500, "Failed to supersede Amazon Plaid transactions", error);
  return { count: data?.length || 0, matches: [] };
}

function sanitizeHttpErrorDetails(details: unknown): unknown {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of ["status", "request_id", "body"]) {
    if (record[key] !== undefined) sanitized[key] = record[key];
  }
  return Object.keys(sanitized).length ? sanitized : undefined;
}
