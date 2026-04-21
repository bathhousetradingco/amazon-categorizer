export type AskAiCategory = {
  name: string;
  description?: string;
  tax_treatment?: string;
  tax_year?: number;
  tax_group?: string;
  deduction_treatment?: string;
  schedule_c_reference?: string;
  tax_note?: string;
};

export type AskAiContext = {
  user_input: string;
  tax_year?: number;
  transaction?: {
    title?: string | null;
    vendor?: string | null;
    amount?: number | null;
    institution?: string | null;
    current_category?: string | null;
  };
  receipt_item?: {
    item_number?: string | null;
    product_name?: string | null;
    receipt_label?: string | null;
    amount?: number | null;
  };
};

const BATHHOUSE_BUSINESS_CONTEXT = [
  "Bathhouse Trading Co sells small-batch handcrafted bath, body, skincare, soap, hair care, home essentials, home fragrance, cleaning, shave, solid fragrance, gifts, bundles, and accessories.",
  "Product families include bath bombs, bath salts/soaks, shower steamers, solid shampoo, solid conditioner, beard care, scrubs, sugar scrubs, foot scrubs, face products, lotions, body butter, body oil, tallow balm, deodorant, lip care, soaps, whipped soap, shave pucks, dish soap, laundry products, room and linen sprays, dryer bags, dryer balls, simmer pots, loofahs, robes, brushes, and soap savers.",
  "Common product inputs may include oils, butters, waxes, tallow, goat milk, honey, salts, sugar, fragrance oils, essential oils, botanicals, surfactants, clays, colorants, extracts, actives, and exfoliants.",
  "Common product packaging may include jars, bottles, tins, tubes, labels, shrink wrap, soap boxes, refill pouches, product bags, caps, pumps, and lids.",
  "Do not confuse product inputs or product packaging with outbound shipping supplies, general office supplies, worker refreshments, personal use, or resale accessories.",
].join("\n");

export function normalizeCategories(input: unknown): AskAiCategory[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry): AskAiCategory | null => {
      if (typeof entry === "string") {
        return { name: entry.trim() };
      }

      if (!entry || typeof entry !== "object") return null;

      const value = entry as Record<string, unknown>;
      const name = String(value.name || "").trim();
      if (!name) return null;

      return {
        name,
        description: String(value.description || "").trim() || undefined,
        tax_treatment: String(value.tax_treatment || "").trim() || undefined,
        tax_year: Number.isFinite(Number(value.tax_year))
          ? Number(value.tax_year)
          : undefined,
        tax_group: String(value.tax_group || "").trim() || undefined,
        deduction_treatment: String(value.deduction_treatment || "").trim() ||
          undefined,
        schedule_c_reference: String(value.schedule_c_reference || "").trim() ||
          undefined,
        tax_note: String(value.tax_note || "").trim() || undefined,
      };
    })
    .filter((entry): entry is AskAiCategory => Boolean(entry?.name));
}

export function buildAskAiPrompt(
  context: AskAiContext,
  categories: AskAiCategory[],
  taxGuidanceBlock = "",
): string {
  const categoryBlock = categories.map((category) => {
    const parts = [
      `- ${category.name}`,
      category.description ? `  Description: ${category.description}` : "",
      category.tax_treatment
        ? `  Tax treatment: ${category.tax_treatment}`
        : "",
      category.tax_group ? `  Tax group: ${category.tax_group}` : "",
      category.deduction_treatment
        ? `  Deduction treatment: ${category.deduction_treatment}`
        : "",
      category.schedule_c_reference
        ? `  Schedule C: ${category.schedule_c_reference}`
        : "",
      category.tax_note ? `  Tax note: ${category.tax_note}` : "",
    ].filter(Boolean);

    return parts.join("\n");
  }).join("\n");

  const transactionBlock = context.transaction
    ? [
      "Transaction context:",
      `- Title: ${context.transaction.title || "Unknown"}`,
      `- Vendor: ${context.transaction.vendor || "Unknown"}`,
      `- Amount: ${
        Number.isFinite(context.transaction.amount)
          ? context.transaction.amount?.toFixed(2)
          : "Unknown"
      }`,
      `- Institution: ${context.transaction.institution || "Unknown"}`,
      `- Current category: ${
        context.transaction.current_category || "Uncategorized"
      }`,
    ].join("\n")
    : "";

  const receiptBlock = context.receipt_item
    ? [
      "Receipt item context:",
      `- Item number: ${context.receipt_item.item_number || "Unknown"}`,
      `- Resolved product name: ${
        context.receipt_item.product_name || "Unknown"
      }`,
      `- Receipt label: ${context.receipt_item.receipt_label || "Unknown"}`,
      `- Receipt item amount: ${
        Number.isFinite(context.receipt_item.amount)
          ? context.receipt_item.amount?.toFixed(2)
          : "Unknown"
      }`,
    ].join("\n")
    : "";

  return [
    "You are categorizing transactions for Bathhouse Trading Co, an LLC using this app to prepare an accountant-ready Schedule C export.",
    `Assume tax year ${
      context.tax_year || 2026
    } unless the app sends a different tax year. Mention review risk when final IRS guidance, accountant judgment, or substantiation could affect treatment.`,
    "Business context:",
    BATHHOUSE_BUSINESS_CONTEXT,
    "Classify the purchase based on what the item was used for in the business, not just the merchant name.",
    "Prefer the most specific category that fits the user's explanation and the category definitions below.",
    "For every request, reason through all available categories; do not limit the answer to common examples or deterministic lookup rules.",
    "If tax treatment is materially uncertain and web search is available, use IRS-only web search to resolve the Schedule C category, limitation, or substantiation issue. Synthesize the answer; do not dump citations into the response.",
    "If facts are still insufficient or the choice depends on tax/accounting treatment, choose Needs Review.",
    "Separate the operational category from deductibility. A transaction can fit a category and still need review or be partly/non-deductible.",
    "",
    `User explanation:\n${context.user_input}`,
    "",
    transactionBlock,
    receiptBlock,
    taxGuidanceBlock,
    "",
    "Available categories:",
    categoryBlock,
    "",
    "Return STRICT JSON ONLY:",
    "{",
    '  "category": "...",',
    '  "reasoning": "...",',
    '  "confidence": "High|Medium|Low",',
    '  "deduction_status": "Deductible|Review Required|Potentially Non-Deductible",',
    '  "tax_consideration": "...",',
    '  "follow_up_question": "..."',
    "}",
    "",
    "Rules:",
    "- category must match exactly one provided category name.",
    '- use "Needs Review" when the correct bucket depends on accountant judgment, capitalization, meals substantiation, mileage method, or missing facts.',
    '- use "Potentially Non-Deductible" when the facts suggest personal use, owner consumption, federal income tax, penalties, or an employee/owner benefit that may not be deductible as claimed.',
    "- support items like paper plates, cups, napkins, paper towels, and breakroom disposables are usually supplies/office-type items, not meals, unless the cost is actually the meal itself.",
    "- if the user describes food, beverages, or lunch for employees or owners, be conservative: meals and fringe-benefit rules are sensitive, and when uncertain choose Needs Review with deduction_status set to Review Required.",
    "- reasoning should be concise and reference the user's use-case.",
    "- deduction_status should reflect tax risk, not category fit.",
    "- tax_consideration should briefly note the Schedule C issue when relevant.",
    "- follow_up_question should be empty unless one short missing fact would materially improve classification.",
  ].filter(Boolean).join("\n");
}
