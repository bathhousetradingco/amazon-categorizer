import { fetchWithTimeout } from "./fetch.ts";

type WebhookRepairParams = {
  plaidBase: string;
  plaidClientId: string;
  plaidSecret: string;
  supabaseUrl: string;
  accessToken: string;
};

type WebhookRepairResult = {
  webhookUrl: string;
  updated: boolean;
};

export function resolvePlaidWebhookUrl(supabaseUrl: string): string {
  return Deno.env.get("PLAID_WEBHOOK_URL") ||
    `${supabaseUrl}/functions/v1/plaid-webhook`;
}

export async function ensurePlaidItemWebhook(
  params: WebhookRepairParams,
): Promise<WebhookRepairResult> {
  const webhookUrl = resolvePlaidWebhookUrl(params.supabaseUrl);

  const webhookRes = await fetchWithTimeout(`${params.plaidBase}/item/webhook/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: params.plaidClientId,
      secret: params.plaidSecret,
      access_token: params.accessToken,
      webhook: webhookUrl,
    }),
  });

  const webhookData = await webhookRes.json();

  if (!webhookRes.ok || webhookData.error) {
    throw new Error(
      `Plaid webhook update failed: ${webhookData?.error_message || webhookData?.error_code || webhookRes.status}`,
    );
  }

  return { webhookUrl, updated: true };
}
