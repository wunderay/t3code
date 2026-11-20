import { describe, expect, it } from "vite-plus/test";

import { amountOrNone } from "./CoordinatorBoardSettings";

describe("amountOrNone", () => {
  it("keeps a cap of 0, leaves blank as no cap and refuses what is not an amount", () => {
    expect(amountOrNone("0", 1e6)).toBe(0);
    expect(amountOrNone("2.5", 3600)).toBe(9000);
    expect(amountOrNone(" ", 1e6)).toBeNull();
    expect(amountOrNone("-1", 1e6)).toBeUndefined();
    expect(amountOrNone("five", 1e6)).toBeUndefined();
  });
});
