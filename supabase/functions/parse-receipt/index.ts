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
import {
  buildOcrInput,
  requestTabscannerExtraction,
  extractJsonFromModelResponse,
  normalizeIncomingFilePath,
  mergeExtractedReceiptItems,
  parseReceiptItems,
  parseCurrencyToNumber,
  parseTax,
  prepareReceiptAsset,
  safeParseJsonResponse,
} from "../_shared/receipt.ts";
import { enrichLineItems } from "../_shared/enrich-line-items.ts";

const SUPABASE_URL = getRequiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = getRequiredEnv("SUPABASE_ANON_KEY");
const OPENAI_API_KEY = getRequiredEnv("OPENAI_API_KEY");
const TABSCANNER_API_KEY = Deno.env.get("TABSCANNER_API_KEY") ?? undefined;
const SERPAPI_API_KEY = Deno.env.get("SERPAPI_KEY") ?? Deno.env.get("SERPAPI_API_KEY") ?? undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireAuthenticatedUser(req);
    const body = await parseJsonBody(req);
    const filePath = normalizeIncomingFilePath(body.filePath);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await assertReceiptBelongsToUser(adminClient, user.id, filePath);

    const blob = await downloadReceiptBlob(adminClient, filePath);
    const asset = await prepareReceiptAsset(filePath, blob);
    const tabscannerData = await requestTabscannerExtraction({
      asset,
      apiKey: TABSCANNER_API_KEY,
      timeoutMs: 12000,
    });
    const extraction = await requestExtraction(asset, tabscannerData);
    const parsed = extractJsonFromModelResponse(extraction);

    if (!parsed) {
      throw new HttpError(422, "OCR did not return parseable JSON");
    }

    const store = detectStoreType(parsed.store, parsed.merchant, tabscannerData?.store, tabscannerData?.merchant);
    if (!SERPAPI_API_KEY) {
      console.log("SERPAPI_KEY missing");
    }
    const items = parseReceiptItems(
      mergeExtractedReceiptItems(parsed.items, tabscannerData?.items),
      { store },
    );
    const enrichedItems = await enrichLineItems({
      adminClient,
      items,
      openAiApiKey: OPENAI_API_KEY,
      serpApiKey: SERPAPI_API_KEY,
      store,
    });

    return jsonResponse({
      success: true,
      data: {
        items: enrichedItems,
        tax: parseTax(firstFiniteNumber(tabscannerData?.tax, parsed.tax)),
        receipt_total: parseCurrencyToNumber(firstFiniteNumber(tabscannerData?.total, parsed.total)),
        store,
      },
      meta: {
        user_id: user.id,
        file_path: filePath,
      },
    });
  } catch (error: unknown) {
    const httpError = toHttpError(error);
    return jsonResponse(
      {
        success: false,
        error: {
          code: `PARSE_RECEIPT_${httpError.status}`,
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

  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(401, "Invalid or expired JWT", error ? { auth_error: error.message } : undefined);
  }

  return data.user;
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

  if (error) throw new HttpError(500, "Unable to validate receipt ownership", { db_error: error.message });
  if (!data) throw new HttpError(403, "Receipt does not belong to authenticated user", { file_path: filePath });
}

async function downloadReceiptBlob(adminClient: ReturnType<typeof createClient>, filePath: string): Promise<Blob> {
  const { data, error } = await adminClient.storage.from("receipts").download(filePath);

  if (error || !data) {
    throw new HttpError(400, "Failed to download receipt", {
      file_path: filePath,
      storage_error: error?.message ?? "unknown",
    });
  }

  return data;
}

async function requestExtraction(
  asset: Awaited<ReturnType<typeof prepareReceiptAsset>>,
  tabscannerData: Awaited<ReturnType<typeof requestTabscannerExtraction>> = null,
) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      input: [{ role: "user", content: buildOcrInput(asset, { tabscannerData }) }],
      max_output_tokens: 1200,
    }),
  });

  const payload = await safeParseJsonResponse(response);
  if (!response.ok) {
    throw new HttpError(502, "OpenAI OCR request failed", {
      status: response.status,
      openai_error: payload?.error?.message ?? payload?.raw ?? null,
      file_mime_type: asset.mimeType,
    });
  }

  return payload;
}

function detectStoreType(...candidates: unknown[]): "sams_club" | "walmart" | "generic" {
  const combined = candidates.map((value) => String(value ?? "").toLowerCase()).join(" ");
  if (combined.includes("sam") || combined.includes("sams club")) return "sams_club";
  if (combined.includes("walmart")) return "walmart";
  return "generic";
}
