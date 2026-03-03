import {
  detectSamsClubQuantity,
  groupSamsClubReceiptLines,
  parseSamsClubGroup,
} from "./sams-club-receipt.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("groupSamsClubReceiptLines groups continuation lines under the same item", () => {
  const groups = groupSamsClubReceiptLines([
    "0990008301 FG 40.3OZ B",
    "2 AT 1 FOR 16.58",
    "0990282589 MM OLIVE OI 18.98",
  ]);

  assert(groups.length === 2, `expected 2 groups, got ${groups.length}`);
  assert(groups[0].line1 === "0990008301 FG 40.3OZ B", "unexpected first line");
  assert(groups[0].continuationLines.length === 1, "expected one continuation line");
});

Deno.test("parseSamsClubGroup extracts raw and normalized item numbers", () => {
  const parsed = parseSamsClubGroup({
    line1: "0990282589 MM OLIVE OI 18.98",
    continuationLines: [],
  });

  assert(parsed !== null, "expected parsed item");
  assert(parsed.item_number_raw === "0990282589", `unexpected raw number ${parsed.item_number_raw}`);
  assert(parsed.item_number_normalized === "990282589", `unexpected normalized number ${parsed.item_number_normalized}`);
  assert(parsed.quantity === 1, `unexpected quantity ${parsed.quantity}`);
});

Deno.test("detectSamsClubQuantity reads quantity from promo continuation line", () => {
  const quantity = detectSamsClubQuantity(["6 AT 1 FOR 8.64"]);
  assert(quantity === 6, `expected quantity 6, got ${quantity}`);
});
