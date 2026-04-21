import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildAmazonBusinessAuthorizeUrl,
  getAmazonBusinessConfig,
  normalizeAmazonBusinessMarketplaceRegion,
  normalizeAmazonBusinessRegion,
} from "../_shared/amazon-business.ts";
import { corsHeaders, HttpError, jsonResponse, parseJsonBody, toHttpError } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireUser(req);
    const body = await parseJsonBody(req);
    const region = normalizeAmazonBusinessRegion(body.region);
    const marketplaceRegion = normalizeAmazonBusinessMarketplaceRegion(body.marketplace_region);
    const state = crypto.randomUUID();
    const config = getAmazonBusinessConfig();
    const redirectUri = config.redirectUri || `${SUPABASE_URL}/functions/v1/amazon-business-auth-callback`;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("amazon_business_oauth_states")
      .insert({
        state,
        user_id: user.id,
        region,
        marketplace_region: marketplaceRegion,
        expires_at: expiresAt,
      });

    if (error) throw new HttpError(500, "Failed to create Amazon Business OAuth state", error);

    return jsonResponse({
      success: true,
      state,
      region,
      marketplace_region: marketplaceRegion,
      authorization_url: buildAmazonBusinessAuthorizeUrl({
        authorizationUrl: config.authorizationUrl,
        redirectUri,
        state,
      }),
      expires_at: expiresAt,
    });
  } catch (error) {
    const httpError = toHttpError(error);
    return jsonResponse({ success: false, message: httpError.message }, httpError.status);
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
