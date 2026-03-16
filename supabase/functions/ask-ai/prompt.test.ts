import { assertEquals, assertMatch } from "jsr:@std/assert";
import { buildAskAiPrompt, normalizeCategories } from "./prompt.ts";

Deno.test("normalizeCategories accepts strings and rich category objects", () => {
  const normalized = JSON.parse(JSON.stringify(normalizeCategories([
    "Needs Review",
    {
      name: "Office Supplies",
      description: "Paper and pens",
      tax_treatment: "expense",
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
      },
    ],
  );
});

Deno.test("buildAskAiPrompt includes transaction and receipt context", () => {
  const prompt = buildAskAiPrompt(
    {
      user_input: "We used this for product labels.",
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
});
