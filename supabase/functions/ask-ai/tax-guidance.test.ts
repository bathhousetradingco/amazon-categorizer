import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  applyTaxGuidance,
  buildTaxGuidancePromptBlock,
  lookupTaxGuidance,
} from "./tax-guidance.ts";
import type { AskAiCategory } from "./prompt.ts";

const categories: AskAiCategory[] = [
  { name: "COGS - Ingredients" },
  { name: "COGS - Packaging" },
  { name: "COGS - Resale Inventory" },
  { name: "COGS - Shipping from Suppliers" },
  { name: "Shipping Supplies" },
  { name: "Shipping to Customers" },
  { name: "Advertising & Marketing" },
  { name: "Commissions & Merchant Fees" },
  { name: "Software & Subscriptions" },
  { name: "Insurance" },
  { name: "Utilities" },
  { name: "Office Supplies" },
  { name: "Equipment & Fixed Assets" },
  { name: "Meals & Refreshments" },
  { name: "Professional Services" },
  { name: "Vehicle / Fuel" },
  { name: "Taxes & Licenses" },
  { name: "Interest Expense" },
  { name: "Needs Review" },
];

Deno.test("lookupTaxGuidance classifies coffee for workers as meals review", () => {
  const guidance = lookupTaxGuidance({
    user_input: "We buy coffee for us and volunteers to drink while we work.",
    receipt_item: {
      product_name: "Folgers Dark Roast Ground Coffee",
      amount: 13.98,
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Meals & Refreshments");
  assertEquals(guidance?.deduction_status, "Review Required");
  assertEquals(guidance?.id, "worker-refreshments");
});

Deno.test("applyTaxGuidance preserves OpenAI category for advisory tax guidance", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Coffee for the team while working in the studio.",
    receipt_item: {
      product_name: "Member's Mark Coffee",
    },
  }, categories);
  const result = applyTaxGuidance(
    {
      category: "Office Supplies",
      reasoning: "Used in the office.",
      confidence: "Medium",
      deduction_status: "Deductible",
      tax_consideration: "",
      follow_up_question: "",
    },
    guidance,
    categories,
  );

  assertEquals(result.category, "Office Supplies");
  assertEquals(result.deduction_status, "Deductible");
  assertStringIncludes(result.tax_consideration || "", "de minimis meals");
});

Deno.test("applyTaxGuidance still forces hard personal-use safety overrides", () => {
  const guidance = lookupTaxGuidance({
    user_input: "This was for home and family use, not business.",
    transaction: {
      title: "Amazon purchase",
    },
  }, categories);
  const result = applyTaxGuidance(
    {
      category: "Office Supplies",
      reasoning: "The purchase looks like supplies.",
      confidence: "Medium",
      deduction_status: "Deductible",
      tax_consideration: "",
      follow_up_question: "",
    },
    guidance,
    categories,
  );

  assertEquals(result.category, "Needs Review");
  assertEquals(result.deduction_status, "Potentially Non-Deductible");
  assertStringIncludes(result.reasoning || "", "personal or owner use");
});

Deno.test("lookupTaxGuidance routes product inputs to COGS ingredients", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Coffee grounds used as an ingredient in a soap batch.",
    receipt_item: {
      product_name: "Ground Coffee",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "COGS - Ingredients");
});

Deno.test("lookupTaxGuidance routes product labels to COGS packaging", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Labels that go on finished soap products.",
    transaction: {
      title: "Product label order",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "COGS - Packaging");
});

Deno.test("lookupTaxGuidance understands Bathhouse product packaging terms", () => {
  const guidance = lookupTaxGuidance({
    user_input: "This is packaging for our shower steamers.",
    transaction: {
      title: "Clear shrink wrap bags",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "COGS - Packaging");
});

Deno.test("lookupTaxGuidance understands Bathhouse product ingredient terms", () => {
  const guidance = lookupTaxGuidance({
    user_input: "This is an ingredient that goes in our shower steamers.",
    receipt_item: {
      product_name: "Menthol crystals",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "COGS - Ingredients");
});

Deno.test("lookupTaxGuidance routes outbound postage separately from freight-in", () => {
  const guidance = lookupTaxGuidance({
    user_input: "USPS postage to ship customer orders.",
    transaction: {
      title: "USPS Click-N-Ship",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Shipping to Customers");
});

Deno.test("lookupTaxGuidance routes resale inventory before product ingredients", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Coffee bags bought wholesale to resell as finished goods.",
    receipt_item: {
      product_name: "Ground Coffee",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "COGS - Resale Inventory");
});

Deno.test("lookupTaxGuidance does not treat bottled water as product packaging", () => {
  const guidance = lookupTaxGuidance({
    user_input:
      "Bottled water for volunteers to drink while working at the market.",
    receipt_item: {
      product_name: "Member's Mark Bottled Water",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Meals & Refreshments");
  assertEquals(guidance?.id, "worker-refreshments");
});

Deno.test("lookupTaxGuidance routes water bills to utilities", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Water bill for the production space.",
    transaction: {
      title: "City Water Utility",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Utilities");
});

Deno.test("lookupTaxGuidance routes public food samples to advertising review", () => {
  const guidance = lookupTaxGuidance({
    user_input:
      "Free coffee samples given to the general public as a market promotion.",
    receipt_item: {
      product_name: "Coffee",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Advertising & Marketing");
  assertEquals(guidance?.deduction_status, "Review Required");
});

Deno.test("lookupTaxGuidance routes business content subscriptions to subscription review", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Recipe subscription used for product development ideas.",
    transaction: {
      title: "PATREON",
    },
    receipt_item: {
      receipt_label: "All Recipes + One Monthly Bonus Recipe",
      amount: 7,
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Software & Subscriptions");
  assertEquals(guidance?.deduction_status, "Review Required");
});

Deno.test("lookupTaxGuidance routes printer ink to office supplies instead of equipment", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Ink cartridges for printing product labels.",
    transaction: {
      title: "Printer ink cartridge refill",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Office Supplies");
  assertEquals(guidance?.id, "office-supplies");
});

Deno.test("lookupTaxGuidance still routes a label printer to equipment review", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Label printer for printing product labels.",
    transaction: {
      title: "Thermal label printer",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Equipment & Fixed Assets");
  assertEquals(guidance?.id, "equipment");
});

Deno.test("applyTaxGuidance does not force broad equipment guidance over OpenAI context", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Label printer for printing product labels.",
    transaction: {
      title: "Thermal label printer",
    },
  }, categories);
  assertEquals(guidance?.id, "equipment");
  const result = applyTaxGuidance(
    {
      category: "Office Supplies",
      reasoning:
        "The user's description makes this an office workflow supply, not inventory or packaging.",
      confidence: "Medium",
      deduction_status: "Deductible",
      tax_consideration: "Consumable supplies are generally expensed.",
      follow_up_question: "",
    },
    guidance,
    categories,
  );

  assertEquals(result.category, "Office Supplies");
  assertEquals(result.deduction_status, "Deductible");
  assertStringIncludes(result.reasoning || "", "office workflow supply");
});

Deno.test("buildTaxGuidancePromptBlock includes rule and source basis", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Coffee for volunteers while they work.",
    receipt_item: {
      product_name: "Coffee",
    },
  }, categories);
  const block = buildTaxGuidancePromptBlock(guidance);

  assertStringIncludes(block, "Tax guidance lookup:");
  assertStringIncludes(block, "IRS Pub. 15-B");
  assertStringIncludes(block, "advisory tax/category context");
});
