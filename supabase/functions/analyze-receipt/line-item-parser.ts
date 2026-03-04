export const ITEM_NUMBER_LINE_PATTERN = /(?:^|\D)(\d{9,12})(?=\D|$)/;
export const ITEM_NUMBER_WITH_TEXT_PATTERN = /\d{9,12}.*[A-Za-z]|[A-Za-z].*\d{9,12}/;

export function isLikelyLineItem(line: string): boolean {
  return ITEM_NUMBER_WITH_TEXT_PATTERN.test(line);
}

export function extractLineItemNumber(line: string): string {
  const match = String(line || "").match(ITEM_NUMBER_LINE_PATTERN);
  return match?.[1] || "";
}

export function normalizeProductNumber(value: string): string {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

export function dedupeItemNumbers(values: unknown[]): string[] {
  const normalized = values
    .map((value) => String(value || "").replace(/\D/g, ""))
    .filter((value) => /^\d{9,12}$/.test(value))
    .map((value) => normalizeProductNumber(value))
    .filter(Boolean);

  return [...new Set(normalized)];
}

export function extractItemNumbersFromLineItems(lines: string[]): string[] {
  const found: string[] = [];

  for (const line of lines) {
    if (!isLikelyLineItem(line)) continue;

    const number = extractLineItemNumber(line);
    if (number) found.push(number);
  }

  return dedupeItemNumbers(found);
}
