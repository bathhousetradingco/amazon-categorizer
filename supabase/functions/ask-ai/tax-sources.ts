export type TaxSourceRef = {
  id: string;
  title: string;
  url: string;
  note: string;
  as_of: string;
};

const AS_OF = "2026-04-21";

const TAX_SOURCE_REFS: Record<string, TaxSourceRef> = {
  "irs-schedule-c": {
    id: "irs-schedule-c",
    title: "IRS Instructions for Schedule C",
    url: "https://www.irs.gov/instructions/i1040sc",
    note: "Primary IRS mapping for Schedule C expense lines, COGS, vehicle expenses, meals, other expenses, and depreciation references.",
    as_of: AS_OF,
  },
  "irs-pub-334": {
    id: "irs-pub-334",
    title: "IRS Publication 334, Tax Guide for Small Business",
    url: "https://www.irs.gov/publications/p334",
    note: "Small-business guidance for ordinary business expenses, inventory, and recordkeeping.",
    as_of: AS_OF,
  },
  "irs-pub-463": {
    id: "irs-pub-463",
    title: "IRS Publication 463, Travel, Gift, and Car Expenses",
    url: "https://www.irs.gov/publications/p463",
    note: "IRS guidance for business travel, meals, gifts, car expenses, substantiation, and meal limitations/exceptions.",
    as_of: AS_OF,
  },
  "irs-pub-15b": {
    id: "irs-pub-15b",
    title: "IRS Publication 15-B, Employer's Tax Guide to Fringe Benefits",
    url: "https://www.irs.gov/publications/p15b",
    note: "IRS fringe-benefit guidance, including de minimis food and beverage treatment.",
    as_of: AS_OF,
  },
  "irs-pub-946": {
    id: "irs-pub-946",
    title: "IRS Publication 946, How To Depreciate Property",
    url: "https://www.irs.gov/publications/p946",
    note: "IRS depreciation, Section 179, and business asset guidance.",
    as_of: AS_OF,
  },
  "irs-2026-mileage": {
    id: "irs-2026-mileage",
    title: "IRS 2026 Standard Mileage Rate Notice",
    url: "https://www.irs.gov/newsroom/irs-sets-2026-business-standard-mileage-rate-at-725-cents-per-mile-up-25-cents",
    note: "IRS announcement for the 2026 business standard mileage rate.",
    as_of: AS_OF,
  },
};

export function resolveTaxSourceRefs(sourceIds: string[] | undefined): TaxSourceRef[] {
  if (!Array.isArray(sourceIds)) return [];

  const seen = new Set<string>();
  const refs: TaxSourceRef[] = [];

  sourceIds.forEach((id) => {
    const source = TAX_SOURCE_REFS[id];
    if (!source || seen.has(source.id)) return;
    seen.add(source.id);
    refs.push(source);
  });

  return refs;
}

export function formatTaxSourceRefs(sourceIds: string[] | undefined): string {
  return resolveTaxSourceRefs(sourceIds)
    .map((source) => `- ${source.title}: ${source.url} (${source.note})`)
    .join("\n");
}

export function isTaxSourceRef(value: unknown): value is TaxSourceRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return Boolean(
    String(ref.id || "").trim() &&
      String(ref.title || "").trim() &&
      /^https:\/\/www\.irs\.gov\//.test(String(ref.url || "").trim()),
  );
}
