import { assertEquals, assertMatch } from "jsr:@std/assert";
import { buildAskAiPrompt, normalizeCategories } from "./prompt.ts";

Deno.test("normalizeCategories accepts strings and rich category objects", () => {
  const normalized = JSON.parse(JSON.stringify(normalizeCategories([
    "Needs Review",
    {
      name: "Office Supplies",
      description: "Paper and pens",
      tax_treatment: "expense",
      source_refs: [{
        id: "irs-schedule-c",
        title: "IRS Instructions for Schedule C",
        url: "https://www.irs.gov/instructions/i1040sc",
        note: "Schedule C line mapping.",
        as_of: "2026-04-21",
      }],
    }
  ])));

  assertEquals(
    normalized,
    [
      { name: "Needs Review" },
      {
        name: "Office Supplies",
        description: "Paper and pens",
        tax_treatment: "expense",
        source_refs: [{
          id: "irs-schedule-c",
          title: "IRS Instructions for Schedule C",
          url: "https://www.irs.gov/instructions/i1040sc",
          note: "Schedule C line mapping.",
          as_of: "2026-04-21",
        }],
      },
    ],
  );
});

Deno.test("buildAskAiPrompt includes transaction and receipt context", () => {
  const prompt = buildAskAiPrompt(
    {
      user_input: "We used this for product labels.",
      tax_year: 2026,
      transaction: {
        title: "SAMS CLUB",
        vendor: "Sam's Club",
        amount: 22.48,
      },
      receipt_item: {
        item_number: "990008301",
        product_name: "Folgers Dark Roast Ground Coffee",
      },
    },
    [{ name: "COGS - Packaging", description: "Packaging attached to product." }],
  );

  assertMatch(prompt, /Bathhouse Trading Co/);
  assertMatch(prompt, /Item number: 990008301/);
  assertMatch(prompt, /COGS - Packaging/);
  assertMatch(prompt, /deduction_status/);
  assertMatch(prompt, /paper plates, cups, napkins/);
  assertMatch(prompt, /all available categories/);
  assertMatch(prompt, /tax year 2026/);
  assertMatch(prompt, /Use only the provided IRS source refs/);
});

Deno.test("buildAskAiPrompt includes deterministic tax guidance block", () => {
  const prompt = buildAskAiPrompt(
    {
      user_input: "Coffee for volunteers while they work.",
    },
    [{ name: "Meals & Refreshments" }],
    "Tax guidance lookup:\n- Recommended category: Meals & Refreshments",
  );

  assertMatch(prompt, /Tax guidance lookup/);
  assertMatch(prompt, /Recommended category: Meals & Refreshments/);
});
