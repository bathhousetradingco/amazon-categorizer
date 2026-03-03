export type SamsClubLineGroup = {
  line1: string;
  continuationLines: string[];
};

export type ParsedSamsClubItem = {
  raw_line: string;
  item_number_raw: string;
  item_number_normalized: string;
  quantity: number;
};

const ITEM_NUMBER_REGEX = /^\s*(\d{6,12})/;
const STARTS_WITH_DIGITS_REGEX = /^\s*\d+/;
const QUANTITY_PROMO_REGEX = /^\s*(\d{1,4})\s+AT\s+1\s+FOR\b/i;

export function groupSamsClubReceiptLines(rawLines: unknown): SamsClubLineGroup[] {
  if (!Array.isArray(rawLines)) return [];

  const groups: SamsClubLineGroup[] = [];
  for (const candidate of rawLines) {
    const line = String(candidate ?? "").trim();
    if (!line) continue;

    if (STARTS_WITH_DIGITS_REGEX.test(line)) {
      groups.push({ line1: line, continuationLines: [] });
      continue;
    }

    const current = groups[groups.length - 1];
    if (current) {
      current.continuationLines.push(line);
    }
  }

  return groups;
}

export function parseSamsClubGroup(group: SamsClubLineGroup): ParsedSamsClubItem | null {
  const itemMatch = group.line1.match(ITEM_NUMBER_REGEX);
  if (!itemMatch) return null;

  const item_number_raw = itemMatch[1];
  if (!/^\d+$/.test(item_number_raw)) return null;

  const item_number_normalized = item_number_raw.replace(/^0+/, "");
  if (!item_number_normalized) return null;

  const quantity = detectSamsClubQuantity(group.continuationLines);

  return {
    raw_line: group.line1,
    item_number_raw,
    item_number_normalized,
    quantity,
  };
}

export function detectSamsClubQuantity(continuationLines: string[]): number {
  for (const line of continuationLines) {
    const promoMatch = line.match(QUANTITY_PROMO_REGEX);
    if (promoMatch) {
      const quantity = Number.parseInt(promoMatch[1], 10);
      if (Number.isFinite(quantity) && quantity > 0) return quantity;
    }
  }

  return 1;
}

export function isAcceptableProductTitle(title: string | null): boolean {
  if (!title) return false;
  const normalized = title.trim();
  if (!normalized) return false;

  const lowered = normalized.toLowerCase();
  const blockedTokens = [
    "blog",
    "forum",
    "reddit",
    "youtube",
    "facebook",
    "instagram",
    "pinterest",
    "wikipedia",
    "faq",
    "sign in",
    "login",
    "category",
    "sitemap",
  ];

  return !blockedTokens.some((token) => lowered.includes(token));
}
