export const RECEIPT_NOISE_TOKENS = [
  "subtotal",
  "sub total",
  "total",
  "tax",
  "discount",
  "coupon",
  "change",
  "cash",
  "visa",
  "mastercard",
  "debit",
  "credit",
  "balance",
  "authorization",
  "approved",
  "payment",
  "savings",
  "scan",
  "void",
  "refund",
  "cashback",
  "tender",
  "item count",
] as const;

const ABBREVIATION_MAP: Record<string, string> = {
  CHKN: "Chicken",
  BRST: "Breast",
  BNLS: "Boneless",
  SKNLS: "Skinless",
  ORG: "Organic",
  FRT: "Fresh",
  FRZN: "Frozen",
  BNS: "Beans",
  TOM: "Tomato",
  TOMS: "Tomatoes",
  CKN: "Chicken",
  GRND: "Ground",
  BEEF: "Beef",
  BRKFST: "Breakfast",
  PKG: "Package",
  CTN: "Carton",
  CHZ: "Cheese",
  MLK: "Milk",
  YGRT: "Yogurt",
  WTR: "Water",
  LT: "Light",
  LG: "Large",
  MED: "Medium",
  SM: "Small",
  DZ: "Dozen",
  WHL: "Whole",
  BNLSS: "Boneless",
};

const STOP_WORDS = new Set(["pkg", "package", "ea", "each", "ct", "count"]);

export type LineItemQuality = {
  score: number;
  flags: string[];
};

export function normalizeLineItemName(rawName: string): string {
  const ascii = rawName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s\-\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!ascii) return "";

  const expanded = ascii
    .split(" ")
    .filter(Boolean)
    .map((token) => expandToken(token))
    .filter((token) => !STOP_WORDS.has(token.toLowerCase()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return titleCase(expanded);
}

export function extractSkuCandidate(rawName: string, code: string | null): string | null {
  const candidates = [code ?? "", rawName]
    .flatMap((value) => value.match(/\b\d{6,14}\b/g) ?? [])
    .map((value) => value.replace(/^0+/, ""))
    .filter((value) => value.length >= 5 && value.length <= 14);

  return candidates[0] ?? null;
}

export function isNonPurchasableLine(name: string, amount: number): boolean {
  if (!name || !Number.isFinite(amount) || amount <= 0) return true;
  const lowered = name.toLowerCase();
  return RECEIPT_NOISE_TOKENS.some((token) => lowered.includes(token));
}

export function scoreLineItemQuality(rawName: string, normalizedName: string, sku: string | null): LineItemQuality {
  let score = 0.5;
  const flags: string[] = [];

  if (normalizedName.length >= 6) score += 0.15;
  else flags.push("very_short_name");

  if (/\d/.test(normalizedName)) {
    score -= 0.1;
    flags.push("contains_numbers");
  }

  if (rawName.length - normalizedName.length > 8) {
    score += 0.1;
    flags.push("cleaned_noise");
  }

  if (sku) {
    score += 0.15;
    flags.push("sku_detected");
  }

  if (/(item|misc|unknown)/i.test(normalizedName)) {
    score -= 0.2;
    flags.push("generic_name");
  }

  return { score: Math.max(0, Math.min(1, Number(score.toFixed(2)))), flags };
}

function expandToken(token: string): string {
  const uppercase = token.toUpperCase();
  const expanded = ABBREVIATION_MAP[uppercase];
  return expanded ?? token;
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .map((word) => {
      if (!word) return word;
      if (/^(oz|lb|pk|ct|ml|l)$/i.test(word)) return word.toUpperCase();
      return `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}
