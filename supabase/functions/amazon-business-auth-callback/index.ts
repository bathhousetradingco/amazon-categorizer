import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  exchangeAmazonBusinessAuthCode,
  getAmazonBusinessConfig,
} from "../_shared/amazon-business.ts";
import { corsHeaders, HttpError, jsonResponse, toHttpError } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const code = String(url.searchParams.get("code") || "").trim();
    const state = String(url.searchParams.get("state") || "").trim();
    const error = String(url.searchParams.get("error") || "").trim();

    if (error) throw new HttpError(400, `Amazon authorization failed: ${error}`);
    if (!code || !state) throw new HttpError(400, "Missing Amazon authorization code or state");

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: stateRow, error: stateError } = await supabase
      .from("amazon_business_oauth_states")
      .select("state, user_id, region, marketplace_region, expires_at, used_at")
      .eq("state", state)
      .maybeSingle();

    if (stateError) throw new HttpError(500, "Failed to load Amazon OAuth state", stateError);
    if (!stateRow) throw new HttpError(400, "Unknown Amazon OAuth state");
    if (stateRow.used_at) throw new HttpError(400, "Amazon OAuth state was already used");
    if (Date.parse(stateRow.expires_at) < Date.now()) throw new HttpError(400, "Amazon OAuth state expired");

    const token = await exchangeAmazonBusinessAuthCode({
      code,
      config: getAmazonBusinessConfig(),
    });
    if (!token.refresh_token) throw new HttpError(502, "Amazon did not return a refresh token");

    const { error: upsertError } = await supabase
      .from("amazon_business_connections")
      .upsert({
        user_id: stateRow.user_id,
        region: stateRow.region || "NA",
        marketplace_region: stateRow.marketplace_region || "US",
        refresh_token: token.refresh_token,
        status: "connected",
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      }, { onConflict: "user_id" });

    if (upsertError) throw new HttpError(500, "Failed to store Amazon Business connection", upsertError);

    await supabase
      .from("amazon_business_oauth_states")
      .update({ used_at: new Date().toISOString() })
      .eq("state", state);

    return htmlResponse(`
      <h2>Amazon Business connected</h2>
      <p>You can close this tab and return to Bathhouse Categorizer.</p>
    `);
  } catch (error) {
    const httpError = toHttpError(error);
    const wantsJson = (req.headers.get("accept") || "").includes("application/json");
    if (wantsJson) return jsonResponse({ success: false, message: httpError.message }, httpError.status);
    return htmlResponse(`<h2>Amazon Business connection failed</h2><p>${escapeHtml(httpError.message)}</p>`, httpError.status);
  }
});

function htmlResponse(body: string, status = 200): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Amazon Business</title></head><body>${body}</body></html>`, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
