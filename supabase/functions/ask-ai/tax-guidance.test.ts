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
  { name: "Equipment" },
  { name: "Meals" },
  { name: "Professional Services" },
  { name: "Fuel" },
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

  assertEquals(guidance?.recommended_category, "Meals");
  assertEquals(guidance?.deduction_status, "Review Required");
  assertEquals(guidance?.id, "worker-refreshments");
});

Deno.test("applyTaxGuidance overrides generic office supply answers for worker refreshments", () => {
  const guidance = lookupTaxGuidance({
    user_input: "Coffee for the team while working in the studio.",
    receipt_item: {
      product_name: "Member's Mark Coffee",
    },
  }, categories);
  const result = applyTaxGuidance({
    category: "Office Supplies",
    reasoning: "Used in the office.",
    confidence: "Medium",
    deduction_status: "Deductible",
    tax_consideration: "",
    follow_up_question: "",
  }, guidance, categories);

  assertEquals(result.category, "Meals");
  assertEquals(result.deduction_status, "Review Required");
  assertStringIncludes(result.tax_consideration || "", "de minimis meals");
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
    user_input: "Bottled water for volunteers to drink while working at the market.",
    receipt_item: {
      product_name: "Member's Mark Bottled Water",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Meals");
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
    user_input: "Free coffee samples given to the general public as a market promotion.",
    receipt_item: {
      product_name: "Coffee",
    },
  }, categories);

  assertEquals(guidance?.recommended_category, "Advertising & Marketing");
  assertEquals(guidance?.deduction_status, "Review Required");
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
});
