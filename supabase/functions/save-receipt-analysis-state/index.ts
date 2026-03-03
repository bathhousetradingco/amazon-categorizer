import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  HttpError,
  corsHeaders,
  getRequiredEnv,
  jsonResponse,
  parseJsonBody,
  toHttpError,
} from "../_shared/http.ts";
import { normalizeIncomingFilePath } from "../_shared/receipt.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);
    const filePath = normalizeIncomingFilePath(body.filePath);
    const userState = (typeof body.user_state === "object" && body.user_state)
      ? body.user_state as Record<string, unknown>
      : {};

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    await assertReceiptBelongsToUser(adminClient, user.id, filePath);

    const { data: existing, error: existingError } = await adminClient
      .from("receipt_analyses")
      .select("id")
      .eq("user_id", user.id)
      .eq("file_path", filePath)
      .maybeSingle();

    if (existingError) {
      throw new HttpError(500, "Unable to load receipt analysis", { db_error: existingError.message });
    }

    if (!existing) {
      return jsonResponse({
        success: false,
        error: {
          code: "RECEIPT_ANALYSIS_NOT_FOUND",
          message: "Analyze receipt first before saving receipt review state.",
        },
      }, 409);
    }

    const { error } = await adminClient
      .from("receipt_analyses")
      .update({ user_state: userState })
      .eq("user_id", user.id)
      .eq("file_path", filePath);

    if (error) {
      throw new HttpError(500, "Unable to persist receipt analysis user state", { db_error: error.message });
    }

    console.log("RECEIPT_ANALYSIS_USER_STATE_STORED", { user_id: user.id, file_path: filePath });

    return jsonResponse({
      success: true,
      data: {
        file_path: filePath,
        user_state: userState,
      },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    return jsonResponse(
      {
        success: false,
        error: {
          code: `SAVE_RECEIPT_ANALYSIS_STATE_${httpError.status}`,
          message: httpError.message,
          details: httpError.details ?? null,
        },
      },
      httpError.status,
    );
  }
});

async function requireAuthenticatedUser(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new HttpError(401, "Missing Authorization header");

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });

  const { data: userData, error } = await authClient.auth.getUser();
  if (error || !userData.user) {
    throw new HttpError(401, "Invalid or expired JWT", error ? { auth_error: error.message } : undefined);
  }

  return userData.user;
}

async function assertReceiptBelongsToUser(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  filePath: string,
): Promise<void> {
  const { data, error } = await adminClient
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("receipt_url", filePath)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "Unable to validate receipt ownership", { db_error: error.message });
  }

  if (!data) {
    throw new HttpError(403, "Receipt does not belong to authenticated user", { file_path: filePath });
  }
}
