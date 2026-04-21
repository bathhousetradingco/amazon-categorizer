import type { AskAiCategory, AskAiContext } from "./prompt.ts";

export type TaxGuidance = {
  id: string;
  recommended_category: string;
  deduction_status:
    | "Deductible"
    | "Review Required"
    | "Potentially Non-Deductible";
  confidence: "High" | "Medium" | "Low";
  reasoning: string;
  tax_consideration: string;
  follow_up_question?: string;
  source_summary: string;
};

type AskAiResult = {
  category?: string;
  reasoning?: string;
  confidence?: string;
  deduction_status?: string;
  tax_consideration?: string;
  follow_up_question?: string;
};

export function lookupTaxGuidance(
  context: AskAiContext,
  categories: AskAiCategory[],
): TaxGuidance | null {
  const availableCategories = new Set(
    categories.map((category) => category.name),
  );
  const itemText = normalizeLookupText(
    [
      context.transaction?.title,
      context.transaction?.vendor,
      context.receipt_item?.product_name,
      context.receipt_item?.receipt_label,
    ].filter(Boolean).join(" "),
  );
  const useText = normalizeLookupText(context.user_input);
  const combinedText = `${itemText} ${useText}`.trim();

  if (
    /\b(personal|for home|family|owner draw|owner personal|not business|private use)\b/
      .test(useText)
  ) {
    return guidance(availableCategories, {
      id: "personal-use",
      categories: ["Needs Review"],
      deduction_status: "Potentially Non-Deductible",
      confidence: "High",
      reasoning:
        "The explanation suggests personal or owner use rather than an ordinary and necessary business expense.",
      tax_consideration:
        "Personal expenses and owner benefits should not be exported as deductible Schedule C expenses without accountant review.",
      source_summary:
        "Schedule C ordinary-and-necessary business expense standard.",
    });
  }

  if (
    /\b(penalty|penalties|fine|fines|federal income tax|estimated income tax|irs payment|1040 payment)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "tax-penalty-or-income-tax",
      categories: ["Needs Review"],
      deduction_status: "Potentially Non-Deductible",
      confidence: "High",
      reasoning:
        "Federal income tax payments, personal estimated taxes, and penalties are not routine deductible business operating expenses.",
      tax_consideration:
        "Keep out of normal expense categories until the accountant confirms treatment.",
      source_summary: "Schedule C tax and penalty limitations.",
    });
  }

  if (
    /\b(resale|resell|finished goods?|inventory for sale|sell as is|sold as is|wholesale item)\b/
      .test(useText)
  ) {
    return guidance(availableCategories, {
      id: "resale-inventory",
      categories: ["COGS - Resale Inventory", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "The item is bought for resale without becoming an operating supply.",
      tax_consideration:
        "Inventory bought for resale normally belongs in COGS/inventory tracking rather than office or supplies expense.",
      source_summary: "Schedule C Part III COGS/inventory treatment.",
    });
  }

  if (
    isProductPackagingUseCase(combinedText, useText) &&
    !/\b(ship|shipping|mail|postage|ups|usps|fedex)\b/.test(combinedText) &&
    !isPrintingEquipmentOrConsumableUseCase(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "product-packaging",
      categories: ["COGS - Packaging", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "Packaging or labels that stay with the product at sale belong with product cost rather than office supplies.",
      tax_consideration:
        "Keep product packaging separate from shipping materials and general office consumables.",
      source_summary: "Schedule C Part III COGS/inventory support.",
    });
  }

  if (isProductInputUseCase(useText)) {
    return guidance(availableCategories, {
      id: "product-input",
      categories: ["COGS - Ingredients", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "Medium",
      reasoning:
        "The explanation says the item is used as a product input, so the business-use category should follow inventory/COGS rather than a general expense bucket.",
      tax_consideration:
        "Confirm the item physically becomes part of products sold before treating it as COGS.",
      source_summary:
        "Schedule C distinguishes inventory/COGS from ordinary expense categories.",
    });
  }

  if (
    /\b(freight in|inbound shipping|shipping from supplier|supplier shipping|shipping for ingredients|shipping for jars|freight charge)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "freight-in",
      categories: ["COGS - Shipping from Suppliers", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "Shipping paid to receive inventory, ingredients, or product packaging is freight-in.",
      tax_consideration:
        "Freight-in commonly attaches to inventory/product cost rather than customer-delivery expense.",
      source_summary: "Schedule C COGS freight-in treatment.",
    });
  }

  if (
    /\b(shipping box|mailers?|bubble wrap|packing tape|tissue paper|void fill|packing paper|poly mailer|ship orders?|send orders?|customer shipment)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "shipping-supplies",
      categories: ["Shipping Supplies", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "Materials used to ship orders to customers are shipping supplies, not product packaging COGS or office supplies.",
      tax_consideration:
        "Keep outbound shipping materials separate from product packaging attached to inventory.",
      source_summary:
        "Schedule C ordinary business supplies/other expense mapping.",
    });
  }

  if (
    /\b(postage|shipping label|usps|ups|fedex|pirate ship|shipstation|shopify shipping|delivery to customer)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "shipping-to-customers",
      categories: ["Shipping to Customers", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "Postage or carrier fees to deliver customer orders are outbound shipping costs.",
      tax_consideration:
        "Do not mix outbound customer shipping with freight-in from suppliers.",
      source_summary:
        "Schedule C ordinary business delivery/postage expense mapping.",
    });
  }

  if (
    /\b(electric|electricity|water bill|gas utility|internet|wifi|phone service|utility|utilities)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "utilities",
      categories: ["Utilities", "Needs Review"],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning: "The expense appears to be a utility used in the business.",
      tax_consideration:
        "Utilities can be deductible, but mixed home/business use may require allocation.",
      source_summary:
        "Schedule C line 25 utilities; allocation required for mixed use.",
    });
  }

  if (
    isFoodOrBeverage(combinedText) &&
    /\b(general public|public giveaway|free samples?|sampled to customers?|customer samples?|promo|promotion|advertis|marketing|goodwill)\b/
      .test(useText)
  ) {
    return guidance(availableCategories, {
      id: "public-food-advertising",
      categories: [
        "Advertising & Marketing",
        "Meals & Refreshments",
        "Meals",
        "Needs Review",
      ],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning:
        "Food or beverages provided to the general public can be promotional rather than an employee/owner meal.",
      tax_consideration:
        "IRS meal-limit exceptions can apply to food or beverages provided to the general public as advertising, but the facts should be reviewed before export.",
      follow_up_question:
        "Was this provided broadly to the general public, or only to owners, workers, volunteers, or selected customers?",
      source_summary:
        "IRS Pub. 463 exception for meals provided to the general public as advertising.",
    });
  }

  if (isFoodOrBeverage(combinedText) && isWorkerRefreshmentUseCase(useText)) {
    return guidance(availableCategories, {
      id: "worker-refreshments",
      categories: ["Meals & Refreshments", "Meals", "Needs Review"],
      deduction_status: "Review Required",
      confidence: "High",
      reasoning:
        "Food or beverages provided for people working are meal/de minimis fringe-benefit territory, not office supplies.",
      tax_consideration:
        "IRS guidance treats coffee, doughnuts, and soft drinks as de minimis meals/fringe benefits, while Schedule C meal deductions are generally reported on line 24b and are commonly limited. Because volunteers, owners, employees, and post-2025 food/beverage rules can change deductibility, keep this in Meals & Refreshments and review with the accountant.",
      follow_up_question: "",
      source_summary:
        "IRS Pub. 15-B de minimis meals; Schedule C instructions line 24b business meals.",
    });
  }

  if (
    isFoodOrBeverage(combinedText) &&
    /\b(office|supplies?|admin|operations?)\b/.test(useText)
  ) {
    return guidance(availableCategories, {
      id: "food-beverage-not-office-supplies",
      categories: ["Meals & Refreshments", "Meals", "Needs Review"],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning:
        "The item is food or beverage, so it should not be treated as office supplies just because it supports office work.",
      tax_consideration:
        "Classify food and beverage purchases separately from office consumables; review meals/fringe-benefit limits before tax export.",
      follow_up_question:
        "Was this food or drink consumed by workers/owners, provided to customers, or used as a product ingredient?",
      source_summary: "IRS Pub. 15-B and Schedule C meal-expense guidance.",
    });
  }

  if (isFoodOrBeverage(combinedText)) {
    return guidance(availableCategories, {
      id: "food-beverage-general",
      categories: ["Meals & Refreshments", "Meals", "Needs Review"],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning:
        "Food and beverage purchases need meals/fringe-benefit review before tax export.",
      tax_consideration:
        "Business meal deductions are generally limited and require facts about who consumed the food, business purpose, and whether employees, owners, customers, or volunteers were involved.",
      follow_up_question:
        "Who consumed this food or drink, and was it for workers, owners, customers, travel, an event, resale, or product production?",
      source_summary: "IRS Pub. 15-B and Schedule C instructions line 24b.",
    });
  }

  if (
    /\b(facebook ads?|google ads?|meta ads?|advertis|marketing|promo|promotion|sponsorship|booth sign|banner|flyer|business cards?|canva)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "advertising",
      categories: ["Advertising & Marketing", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning: "The expense is for promotion or customer acquisition.",
      tax_consideration:
        "Advertising maps to Schedule C line 8 when ordinary and necessary for the business.",
      source_summary: "Schedule C line 8 advertising.",
    });
  }

  if (
    /\b(shopify fee|square fee|stripe|paypal fee|merchant fee|processing fee|commission|faire commission|transaction fee)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "merchant-fees",
      categories: ["Commissions & Merchant Fees", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "Payment processor or marketplace fees are commissions/merchant fees.",
      tax_consideration:
        "Processor and marketplace fees map cleanly to Schedule C commissions and fees.",
      source_summary: "Schedule C line 10 commissions and fees.",
    });
  }

  if (
    /\b(patreon|paid newsletter|digital content|content subscription|recipe subscription|online course|training course|business training|digital membership|creator membership)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "business-content-subscription",
      categories: [
        "Software & Subscriptions",
        "Professional Services",
        "Needs Review",
      ],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning:
        "The purchase appears to be a paid digital membership, content subscription, or training resource.",
      tax_consideration:
        "Classify business-use subscriptions separately from personal content; confirm it is ordinary and necessary for product development, operations, marketing, or training before export.",
      follow_up_question:
        "Was this subscription used directly for Bathhouse operations, product development, marketing, or training rather than personal use?",
      source_summary:
        "Schedule C ordinary-and-necessary business expense standard; other expense itemization.",
    });
  }

  if (
    /\b(subscription|software|shopify|quickbooks|supabase|plaid|domain|hosting|app|saas|google workspace|microsoft 365)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "software-subscriptions",
      categories: ["Software & Subscriptions", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning:
        "The purchase is a digital tool or subscription used to run the business.",
      tax_consideration:
        "Recurring software is usually tracked as an ordinary business expense or other expense.",
      source_summary: "Schedule C ordinary business expense mapping.",
    });
  }

  if (
    /\b(liability insurance|business insurance|product liability|insurance premium)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "insurance",
      categories: ["Insurance", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning: "The expense is business or product liability insurance.",
      tax_consideration:
        "Business insurance maps to Schedule C line 15 when not health/owner personal coverage.",
      source_summary: "Schedule C line 15 insurance.",
    });
  }

  if (
    /\b(printer paper|receipt paper|ink cartridges?|printer ink|ink refill|toner|label rolls?|label tape|thermal labels?|pens?|file folders?|desk organizers?|office|admin|storage bins?|organizer|clipboard|staples?)\b/
      .test(combinedText) &&
    !isFoodOrBeverage(combinedText) &&
    !isDurableEquipmentUseCase(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "office-supplies",
      categories: ["Office Supplies", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "Medium",
      reasoning:
        "The item is an admin/office consumable rather than inventory, shipping material, food, or equipment.",
      tax_consideration:
        "Office consumables generally map to Schedule C office expense.",
      source_summary: "Schedule C line 18 office expense.",
    });
  }

  if (
    isDurableEquipmentUseCase(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "equipment",
      categories: ["Equipment & Fixed Assets", "Equipment", "Needs Review"],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning:
        "The purchase appears to be durable equipment rather than a consumable supply.",
      tax_consideration:
        "Equipment may need capitalization, depreciation, de minimis safe harbor, or Section 179 review before export.",
      source_summary: "Capitalization/depreciation review for business assets.",
    });
  }

  if (
    /\b(cpa|accountant|bookkeep|lawyer|attorney|legal|consultant|professional service|tax preparer)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "professional-services",
      categories: ["Professional Services", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning: "The expense is for outside professional support.",
      tax_consideration:
        "Professional fees generally map to Schedule C line 17 when business-related.",
      source_summary: "Schedule C line 17 legal and professional services.",
    });
  }

  if (
    /\b(gas|gasoline|fuel|diesel)\b/.test(combinedText) &&
    /\b(market|pickup|supply run|delivery|business trip|miles|vehicle|car|truck)\b/
      .test(useText)
  ) {
    return guidance(availableCategories, {
      id: "fuel",
      categories: ["Vehicle / Fuel", "Fuel", "Needs Review"],
      deduction_status: "Review Required",
      confidence: "Medium",
      reasoning:
        "The expense appears to be vehicle fuel for business travel or supply pickup.",
      tax_consideration:
        "Vehicle expenses need mileage/actual-expense method support and mixed-use allocation.",
      source_summary: "Schedule C vehicle expense substantiation.",
    });
  }

  if (
    /\b(business license|license fee|permit|state filing|sales tax permit|registration fee)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "taxes-licenses",
      categories: ["Taxes & Licenses", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "High",
      reasoning: "The expense is a business license, permit, or filing fee.",
      tax_consideration:
        "Business taxes and licenses map to Schedule C line 23, excluding federal income taxes and penalties.",
      source_summary: "Schedule C line 23 taxes and licenses.",
    });
  }

  if (
    /\b(interest charge|credit card interest|loan interest|business loan interest)\b/
      .test(combinedText)
  ) {
    return guidance(availableCategories, {
      id: "interest-expense",
      categories: ["Interest Expense", "Needs Review"],
      deduction_status: "Deductible",
      confidence: "Medium",
      reasoning:
        "The expense is interest on a business debt or business credit card.",
      tax_consideration:
        "Confirm the underlying debt is business-related and separate principal from interest.",
      source_summary: "Schedule C line 16b other interest.",
    });
  }

  return null;
}

export function buildTaxGuidancePromptBlock(
  guidance: TaxGuidance | null,
): string {
  if (!guidance) return "";

  return [
    "Tax guidance lookup:",
    `- Matched rule: ${guidance.id}`,
    `- Recommended category: ${guidance.recommended_category}`,
    `- Deduction status: ${guidance.deduction_status}`,
    `- Confidence: ${guidance.confidence}`,
    `- Reasoning: ${guidance.reasoning}`,
    `- Tax consideration: ${guidance.tax_consideration}`,
    guidance.follow_up_question
      ? `- Follow-up question: ${guidance.follow_up_question}`
      : "",
    `- Source basis: ${guidance.source_summary}`,
    "Use this as advisory tax/category context only. Weigh it against the user's full explanation, transaction details, and receipt details. Do not force this category if the described business use supports a better category.",
  ].filter(Boolean).join("\n");
}

export function applyTaxGuidance(
  result: AskAiResult,
  guidance: TaxGuidance | null,
  categories: AskAiCategory[],
): AskAiResult {
  if (!guidance) return result;

  const allowed = new Set(categories.map((category) => category.name));
  const recommendedCategory = allowed.has(guidance.recommended_category)
    ? guidance.recommended_category
    : "Needs Review";
  const modelCategory = String(result.category || "").trim();
  const hasAllowedModelCategory = allowed.has(modelCategory);
  const shouldForce = shouldForceTaxSafetyOverride(guidance);
  const category = shouldForce
    ? recommendedCategory
    : hasAllowedModelCategory
    ? modelCategory
    : recommendedCategory;
  const usedGuidanceFallback = !shouldForce && !hasAllowedModelCategory;

  return {
    ...result,
    category,
    confidence: shouldForce || usedGuidanceFallback
      ? guidance.confidence
      : result.confidence,
    deduction_status: shouldForce
      ? guidance.deduction_status
      : result.deduction_status,
    reasoning: shouldForce
      ? mergeSentences(result.reasoning, guidance.reasoning)
      : result.reasoning,
    tax_consideration: mergeSentences(
      result.tax_consideration,
      guidance.tax_consideration,
    ),
    follow_up_question: result.follow_up_question ||
      guidance.follow_up_question || "",
  };
}

function shouldForceTaxSafetyOverride(guidance: TaxGuidance): boolean {
  return new Set([
    "personal-use",
    "tax-penalty-or-income-tax",
  ]).has(guidance.id);
}

function guidance(
  availableCategories: Set<string>,
  input: Omit<TaxGuidance, "recommended_category"> & { categories: string[] },
): TaxGuidance {
  const { categories, ...rest } = input;

  return {
    ...rest,
    recommended_category: chooseAvailableCategory(
      availableCategories,
      categories,
    ),
  };
}

function chooseAvailableCategory(
  availableCategories: Set<string>,
  candidates: string[],
): string {
  return candidates.find((category) => availableCategories.has(category)) ||
    "Needs Review";
}

function normalizeLookupText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFoodOrBeverage(text: string): boolean {
  if (/\b(water bill|water utility|water service)\b/.test(text)) return false;

  return /\b(coffee|espresso|folgers|starbucks|k\s*cup|kcup|tea|cocoa|bottled water|water bottles?|soda|soft drinks?|drink|drinks|beverage|beverages|doughnuts?|donuts?|snacks?|food|lunch|meal|meals|breakfast|candy|cookies?)\b/
    .test(text);
}

function isWorkerRefreshmentUseCase(text: string): boolean {
  return /\b(employee|employees|staff|team|crew|worker|workers|volunteer|volunteers|intern|interns|we|us|our)\b/
    .test(text) &&
    /\b(work|working|shift|shifts|shop|office|studio|production|market|event|drink|drinks|eat|snack|breakroom|break room)\b/
      .test(text);
}

function isDurableEquipmentUseCase(text: string): boolean {
  const textWithoutLabelPrinter = text.replace(
    /\b(?:thermal\s+)?label printer\b/g,
    "",
  );
  if (
    /\b(ink cartridges?|printer ink|ink refill|toner|paper|label rolls?|label tape|thermal labels?|receipt paper|replacement parts?|refills?|consumables?)\b/
      .test(textWithoutLabelPrinter)
  ) {
    return false;
  }

  return /\b(label printer|printer|shelving|rack|desk|chair|table|tool|scale|equipment|machine|washer|dryer|computer|ipad|phone|laptop)\b/
    .test(text);
}

function isPrintingEquipmentOrConsumableUseCase(text: string): boolean {
  return /\b(label printer|printer|ink cartridges?|printer ink|ink refill|toner)\b/
    .test(text);
}

function isProductInputUseCase(text: string): boolean {
  if (
    /\b(ingredient|ingredients|raw material|goes in|go into|put in|inside|used in|for making|make|making|manufacturing|producing|batch|formula|formulation)\b/
      .test(text) &&
    isKnownBathhouseProductTerm(text)
  ) {
    return true;
  }

  return /\b(ingredient|ingredients|raw material|goes in|go into|put in|inside (?:the )?product|used in (?:the )?(?:product|products|soap|scrub|batch|formula)|for (?:making|manufacturing|producing) (?:products?|soap|scrub)|soap batch|scrub batch|formula|formulation|make products?|making products?|used in products?)\b/
    .test(text);
}

function isProductPackagingUseCase(
  combinedText: string,
  useText: string,
): boolean {
  if (
    /\b(product label|ingredient label|soap box|shrink wrap|retail packaging|packaging attached|goes with product)\b/
      .test(combinedText)
  ) {
    return true;
  }

  return /\b(label|labels|packaging|package products?|product boxes?|jars?|bottles?|tubes?|containers?|wrap|shrink wrap|holds product|fill with product)\b/
    .test(useText) &&
    (/\b(product|products|soap|scrub|finished|sell|sale|customer|customers)\b/
      .test(useText) || isKnownBathhouseProductTerm(useText));
}

function isKnownBathhouseProductTerm(text: string): boolean {
  return /\b(shower steamers?|bath bombs?|bath soaks?|bath salts?|solid shampoos?|shampoo bars?|solid conditioners?|conditioner bars?|beard care|beard oil|scrubs?|sugar scrubs?|foot scrubs?|face products?|lotions?|body butter|body oils?|tallow balms?|deodorants?|lip balms?|lip care|soaps?|whipped soaps?|shave pucks?|dish soaps?|laundry products?|room sprays?|linen sprays?|dryer bags?|dryer balls?|simmer pots?|loofahs?|robes?|brushes?|soap savers?|solid fragrances?)\b/
    .test(text);
}

function mergeSentences(left: unknown, right: unknown): string {
  const values = [left, right]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return [...new Set(values)].join(" ");
}
