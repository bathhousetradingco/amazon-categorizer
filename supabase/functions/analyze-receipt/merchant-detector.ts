import type { ReceiptMerchant } from "./parser-types.ts";

type DetectMerchantInput = {
  lines: string[];
  transactionName?: string | null;
  merchantName?: string | null;
};

export function detectReceiptMerchant(input: DetectMerchantInput): ReceiptMerchant {
  const joinedLines = input.lines.join("\n").toLowerCase();
  const merchantContext = `${input.transactionName || ""} ${input.merchantName || ""}`.toLowerCase();
  const combined = `${joinedLines}\n${merchantContext}`;

  if (/\bsam'?s club\b|\bsamsclub\.com\b|\bmember\b|\binst sv\b/.test(combined)) {
    return "sams_club";
  }

  if (/\bwalmart\b|\bwalmart\.com\b|\bwal-mart\b/.test(combined)) {
    return "walmart";
  }

  return "misc";
}
