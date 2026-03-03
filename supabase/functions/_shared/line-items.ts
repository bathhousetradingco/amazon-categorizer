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
  CKNT: "Coconut",
  OIL: "Oil",
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

const STOP_WORDS = new Set(["pkg", "package", "ea", "each"]);

export type LineItemQuality = {
  score: number;
  flags: string[];
};

export type QuantityAndPrice = {
  quantity: number;
  unitPrice: number;
  total: number;
  totalFromLine: number | null;
  expectedTotal: number;
  hasTotalMismatch: boolean;
  source: "at_pattern" | "count_pattern" | "default";
};

export function normalizeLineItem(rawName: string): string {
  const withoutLeadingSku = rawName.replace(/^\s*\d{6,14}\s+/, " ");

  const ascii = withoutLeadingSku
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

export function normalizeLineItemName(rawName: string): string {
  return normalizeLineItem(rawName);
}

export function extractSKU(rawName: string, code: string | null): string | null {
  const candidates = [code ?? "", rawName]
    .flatMap((value) => value.match(/\b\d{6,14}\b/g) ?? [])
    .map((value) => value.replace(/^0+/, ""))
    .filter((value) => value.length >= 5 && value.length <= 14);

  return candidates[0] ?? null;
}

export function extractSkuCandidate(rawName: string, code: string | null): string | null {
  return extractSKU(rawName, code);
}

export function parseQuantityAndPrice(line: string, amount: number): QuantityAndPrice {
  const atPattern = line.match(/\b(\d{1,4})\s*@\s*(\d+(?:\.\d{1,2})?)\b/i);
  if (atPattern) {
    const quantity = Number(atPattern[1]);
    const unitPrice = toMoney(Number(atPattern[2]));
    const expectedTotal = toMoney(quantity * unitPrice);
    const totalFromLine = Number.isFinite(amount) && amount > 0 ? toMoney(amount) : expectedTotal;

    return {
      quantity,
      unitPrice,
      total: expectedTotal,
      totalFromLine,
      expectedTotal,
      hasTotalMismatch: Math.abs(totalFromLine - expectedTotal) > 0.02,
      source: "at_pattern",
    };
  }

  const countPattern = line.match(/\b(\d{1,4})\s*(?:CT|COUNT|PK|PACK)\b/i);
  if (countPattern) {
    const quantity = Number(countPattern[1]);
    const totalFromLine = Number.isFinite(amount) && amount > 0 ? toMoney(amount) : null;
    const unitPrice = totalFromLine ? toMoney(totalFromLine / quantity) : 0;
    const expectedTotal = totalFromLine ? toMoney(quantity * unitPrice) : 0;

    return {
      quantity,
      unitPrice,
      total: totalFromLine ?? 0,
      totalFromLine,
      expectedTotal,
      hasTotalMismatch: false,
      source: "count_pattern",
    };
  }

  return {
    quantity: 1,
    unitPrice: Number.isFinite(amount) ? toMoney(amount) : 0,
    total: Number.isFinite(amount) ? toMoney(amount) : 0,
    totalFromLine: Number.isFinite(amount) ? toMoney(amount) : null,
    expectedTotal: Number.isFinite(amount) ? toMoney(amount) : 0,
    hasTotalMismatch: false,
    source: "default",
  };
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

function toMoney(value: number): number {
  return Number(value.toFixed(2));
}
