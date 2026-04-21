import { fetchWithTimeout } from "./fetch.ts";
import { HttpError } from "./http.ts";

export type AmazonBusinessRegion = "NA" | "EU" | "FE";

export type AmazonBusinessConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  applicationId: string;
  marketplaceUrl: string;
  sandbox: boolean;
};

export type AmazonBusinessTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
};

export type NormalizedAmazonOrderLineItem = {
  order_id: string;
  line_item_key: string;
  order_date: string | null;
  order_status: string | null;
  purchase_order_number: string | null;
  asin: string | null;
  title: string | null;
  seller_name: string | null;
  quantity: number | null;
  item_subtotal: number | null;
  item_tax: number | null;
  item_total: number | null;
  currency: string | null;
  raw: Record<string, unknown>;
};

const REGION_ENDPOINTS: Record<AmazonBusinessRegion, { production: string; sandbox: string }> = {
  NA: {
    production: "https://na.business-api.amazon.com",
    sandbox: "https://sandbox.na.business-api.amazon.com",
  },
  EU: {
    production: "https://eu.business-api.amazon.com",
    sandbox: "https://sandbox.eu.business-api.amazon.com",
  },
  FE: {
    production: "https://jp.business-api.amazon.com",
    sandbox: "https://sandbox.jp.business-api.amazon.com",
  },
};

export function normalizeAmazonBusinessRegion(value: unknown): AmazonBusinessRegion {
  const normalized = String(value || "NA").trim().toUpperCase();
  if (normalized === "EU") return "EU";
  if (normalized === "FE" || normalized === "JP") return "FE";
  return "NA";
}

export function normalizeAmazonBusinessMarketplaceRegion(value: unknown): string {
  const normalized = String(value || "US").trim().toUpperCase().replace(/[^A-Z]/g, "");
  return normalized || "US";
}

export function getAmazonBusinessEndpoint(region: AmazonBusinessRegion, sandbox: boolean): string {
  const endpoints = REGION_ENDPOINTS[region] || REGION_ENDPOINTS.NA;
  return sandbox ? endpoints.sandbox : endpoints.production;
}

export function getAmazonBusinessConfig(): AmazonBusinessConfig {
  return {
    clientId: Deno.env.get("AMAZON_BUSINESS_CLIENT_ID") || "",
    clientSecret: Deno.env.get("AMAZON_BUSINESS_CLIENT_SECRET") || "",
    redirectUri: Deno.env.get("AMAZON_BUSINESS_REDIRECT_URI") || "",
    authorizationUrl: Deno.env.get("AMAZON_BUSINESS_AUTHORIZATION_URL") || "",
    applicationId: Deno.env.get("AMAZON_BUSINESS_APPLICATION_ID") || Deno.env.get("AMAZON_BUSINESS_APP_ID") || "",
    marketplaceUrl: Deno.env.get("AMAZON_BUSINESS_MARKETPLACE_URL") || "https://www.amazon.com",
    sandbox: (Deno.env.get("AMAZON_BUSINESS_SANDBOX") || "").toLowerCase() === "true",
  };
}

export function assertAmazonBusinessConfig(config: AmazonBusinessConfig): void {
  const missing = [
    ["AMAZON_BUSINESS_CLIENT_ID", config.clientId],
    ["AMAZON_BUSINESS_CLIENT_SECRET", config.clientSecret],
    ["AMAZON_BUSINESS_REDIRECT_URI", config.redirectUri],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new HttpError(500, `Missing Amazon Business configuration: ${missing.join(", ")}`);
  }
}

export function buildAmazonBusinessAuthorizeUrl(input: {
  authorizationUrl: string;
  applicationId?: string;
  marketplaceUrl?: string;
  redirectUri: string;
  state: string;
}): string {
  const rawAuthorizationUrl = String(input.authorizationUrl || "").trim();
  const rawApplicationId = String(input.applicationId || "").trim();

  if (!rawAuthorizationUrl && !rawApplicationId) {
    throw new HttpError(
      500,
      "Missing Amazon Business authorization setup. Set AMAZON_BUSINESS_APPLICATION_ID from the Solution Provider Portal app ID, or set AMAZON_BUSINESS_AUTHORIZATION_URL.",
    );
  }

  const url = rawAuthorizationUrl
    ? new URL(rawAuthorizationUrl)
    : new URL("/b2b/abws/oauth", normalizeAmazonBusinessMarketplaceUrl(input.marketplaceUrl));
  if (rawApplicationId && !url.searchParams.get("applicationId")) {
    url.searchParams.set("applicationId", rawApplicationId);
  }
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

function normalizeAmazonBusinessMarketplaceUrl(value: unknown): string {
  const raw = String(value || "https://www.amazon.com").trim().replace(/\/+$/, "");
  if (!raw) return "https://www.amazon.com";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export async function exchangeAmazonBusinessAuthCode(input: {
  code: string;
  config: AmazonBusinessConfig;
}): Promise<AmazonBusinessTokenResponse> {
  assertAmazonBusinessConfig(input.config);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
  });

  return exchangeAmazonToken(body);
}

export async function refreshAmazonBusinessAccessToken(input: {
  refreshToken: string;
  config: AmazonBusinessConfig;
}): Promise<AmazonBusinessTokenResponse> {
  assertAmazonBusinessConfig(input.config);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });

  return exchangeAmazonToken(body);
}

export async function fetchAmazonBusinessOrderLineItems(input: {
  accessToken: string;
  region: AmazonBusinessRegion;
  marketplaceRegion?: string;
  sandbox: boolean;
  orderStartDate: string;
  orderEndDate: string;
  orderIds?: string[];
}): Promise<NormalizedAmazonOrderLineItem[]> {
  const baseUrl = getAmazonBusinessEndpoint(input.region, input.sandbox);
  const items: NormalizedAmazonOrderLineItem[] = [];
  let nextPageToken = "";

  do {
    const url = new URL(`${baseUrl}/reports/2025-06-09/orderLineItemReports`);
    url.searchParams.set("orderStartDate", input.orderStartDate);
    url.searchParams.set("orderEndDate", input.orderEndDate);
    url.searchParams.set("region", normalizeAmazonBusinessMarketplaceRegion(input.marketplaceRegion));
    if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);
    if (input.orderIds?.length) url.searchParams.set("orderIds", input.orderIds.join(","));

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-amz-access-token": input.accessToken,
      },
    }, 30000);
    const payload = await response.json().catch(() => null);
    const requestId = response.headers.get("x-amzn-requestid") ||
      response.headers.get("x-amzn-request-id") ||
      response.headers.get("x-amz-request-id") ||
      "";

    if (!response.ok) {
      const amazonMessage = firstAmazonErrorMessage(payload);
      throw new HttpError(502, [
        `Amazon Business order line item request failed (${response.status})`,
        requestId ? `request ${requestId}` : "",
        amazonMessage,
      ].filter(Boolean).join(": "), {
        status: response.status,
        request_id: requestId || undefined,
        body: payload,
      });
    }

    const rawItems = Array.isArray(payload?.orderLineItemsReport) ? payload.orderLineItemsReport : [];
    items.push(...rawItems.map(normalizeAmazonOrderLineItem).filter(Boolean));
    nextPageToken = String(payload?.nextPageToken || "").trim();
  } while (nextPageToken);

  return items;
}

function firstAmazonErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const direct = stringFromValue(record.message ?? record.error_description ?? record.error);
  if (direct) return direct;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  for (const error of errors) {
    const errorRecord = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const message = stringFromValue(errorRecord.message ?? errorRecord.detail ?? errorRecord.code);
    if (message) return message;
  }
  return "";
}

export function normalizeAmazonOrderLineItem(value: unknown): NormalizedAmazonOrderLineItem {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const orderMetadata = objectValue(record.orderMetadata);
  const productDetails = objectValue(record.productDetails);
  const seller = objectValue(record.seller);
  const orderId = firstString(record, ["orderId", "amazonOrderId", "orderIdentifier", "orderNumber"]) ||
    firstString(orderMetadata, ["orderId", "amazonOrderId", "orderIdentifier", "orderNumber"]);
  const asin = firstString(record, ["asin", "ASIN", "productAsin"]) ||
    firstString(productDetails, ["asin", "ASIN", "productAsin"]);
  const title = firstString(record, ["title", "productTitle", "productName", "itemTitle"]) ||
    firstString(productDetails, ["title", "productTitle", "productName", "itemTitle"]);
  const lineId = firstString(record, ["orderLineItemId", "lineItemId", "orderLineId", "lineItemNumber"]);
  const orderDate = firstString(record, ["orderDate", "purchaseDate", "orderedDate"]) ||
    firstString(orderMetadata, ["orderDate", "purchaseDate", "orderedDate"]);
  const fallbackKey = [asin, title, orderDate].filter(Boolean).join(":");
  const charges = findChargeRecord(record);
  const principalCharge = findChargeAmount(record, ["principal", "item_price", "product"]);
  const taxCharge = findChargeAmount(record, ["tax"]);
  const netTotalCharge = findChargeAmount(record, ["net_total", "total"]);
  const itemSubtotal = firstMoney(record, ["itemSubtotal", "subtotal", "principalAmount", "lineItemSubtotal"]) ??
    firstMoney(charges, ["subtotal", "principal", "itemSubtotal"]) ??
    principalCharge.amount;
  const itemTax = firstMoney(record, ["itemTax", "tax", "taxAmount", "lineItemTax"]) ??
    firstMoney(charges, ["tax", "taxAmount"]) ??
    taxCharge.amount;
  const itemTotal = firstMoney(record, ["itemTotal", "total", "totalAmount", "lineItemTotal"]) ??
    firstMoney(charges, ["total", "totalAmount"]) ??
    netTotalCharge.amount ??
    sumMoney(itemSubtotal, itemTax);

  return {
    order_id: orderId || "unknown-order",
    line_item_key: lineId || fallbackKey || crypto.randomUUID(),
    order_date: orderDate || null,
    order_status: firstString(record, ["orderStatus", "status"]),
    purchase_order_number: firstString(record, ["purchaseOrderNumber", "poNumber", "purchaseOrder"]),
    asin: asin || null,
    title: title || null,
    seller_name: firstString(record, ["sellerName", "seller", "merchantName"]) ||
      firstString(seller, ["name", "sellerName"]) ||
      null,
    quantity: firstNumber(record, ["quantity", "orderedQuantity", "quantityOrdered"]),
    item_subtotal: itemSubtotal,
    item_tax: itemTax,
    item_total: itemTotal,
    currency: firstCurrency(record) || firstCurrency(charges) || principalCharge.currency || taxCharge.currency || netTotalCharge.currency || null,
    raw: record,
  };
}

async function exchangeAmazonToken(body: URLSearchParams): Promise<AmazonBusinessTokenResponse> {
  const response = await fetchWithTimeout("https://api.amazon.com/auth/O2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, 30000);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new HttpError(502, "Amazon token exchange failed", {
      status: response.status,
      body: payload,
    });
  }

  const accessToken = String(payload?.access_token || "").trim();
  if (!accessToken) {
    throw new HttpError(502, "Amazon token exchange did not return an access token", payload);
  }

  return {
    access_token: accessToken,
    refresh_token: String(payload?.refresh_token || "").trim() || undefined,
    token_type: String(payload?.token_type || "").trim() || undefined,
    expires_in: Number.isFinite(Number(payload?.expires_in)) ? Number(payload.expires_in) : undefined,
  };
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const normalized = stringFromValue(record?.[key]);
    if (normalized) return normalized;
  }
  return "";
}

function stringFromValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return stringFromValue(record.date ?? record.value ?? record.displayValue);
  }
  return "";
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(record?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function firstMoney(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null;

  for (const key of keys) {
    const value = record?.[key];
    const amount = normalizeMoneyValue(value);
    if (amount !== null) return amount;
  }
  return null;
}

function normalizeMoneyValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return roundMoney(value);
  if (typeof value === "string") {
    const amount = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(amount) ? roundMoney(amount) : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return normalizeMoneyValue(record.amount ?? record.value ?? record.amountValue);
  }
  return null;
}

function findChargeRecord(record: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [
    record.charges,
    record.charge,
    record.itemCharges,
    record.lineItemCharges,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
    if (Array.isArray(candidate) && candidate[0] && typeof candidate[0] === "object") {
      return candidate[0] as Record<string, unknown>;
    }
  }
  return null;
}

function findChargeAmount(
  record: Record<string, unknown>,
  typeNeedles: string[],
): { amount: number | null; currency: string } {
  const chargeLists = [
    record.charges,
    record.itemCharges,
    record.lineItemCharges,
  ].filter(Array.isArray) as unknown[][];

  for (const chargeList of chargeLists) {
    for (const charge of chargeList) {
      if (!charge || typeof charge !== "object") continue;
      const chargeRecord = charge as Record<string, unknown>;
      const type = String(chargeRecord.type || chargeRecord.chargeType || "").toLowerCase();
      if (!typeNeedles.some((needle) => type.includes(needle))) continue;

      return {
        amount: normalizeMoneyValue(chargeRecord.amount),
        currency: firstCurrency(chargeRecord),
      };
    }
  }

  return { amount: null, currency: "" };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstCurrency(record: Record<string, unknown> | null): string {
  if (!record) return "";
  const direct = firstString(record, ["currency", "currencyCode"]);
  if (direct) return direct;

  for (const value of Object.values(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = firstString(value as Record<string, unknown>, ["currency", "currencyCode"]);
      if (nested) return nested;
    }
  }
  return "";
}

function sumMoney(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return roundMoney((left || 0) + (right || 0));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
