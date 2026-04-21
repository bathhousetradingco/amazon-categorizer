import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, HttpError, jsonResponse, toHttpError } from "../_shared/http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireUser(req);
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: connection, error } = await supabase
      .from("amazon_business_connections")
      .select("status, region, marketplace_region, connected_at, last_sync_at, last_error")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw new HttpError(500, "Failed to load Amazon Business connection status", error);

    const status = String(connection?.status || "not_connected");
    return jsonResponse({
      success: true,
      connected: !!connection && status !== "disconnected",
      status,
      region: connection?.region || null,
      marketplace_region: connection?.marketplace_region || null,
      connected_at: connection?.connected_at || null,
      last_sync_at: connection?.last_sync_at || null,
      last_error: connection?.last_error || null,
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
