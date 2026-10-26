import { describe, expect, it } from "vitest";
import { chooseExpiry } from "./expiry-choice";

const weekly = (expiryDate: string) => ({ expiryDate, expiryKind: "WEEKLY" });

describe("chooseExpiry", () => {
  it("offers every expiry the run stored when the response holds only one book, and shows that book's expiry", () => {
    // The 2026-10-26 case: two books stored, the default read returns the one written last.
    const choice = chooseExpiry({ expiries: [weekly("2026-11-03")], storedExpiries: [weekly("2026-10-27"), weekly("2026-11-03")] }, "");
    expect(choice.options.map((entry) => entry.expiryDate)).toEqual(["2026-10-27", "2026-11-03"]);
    expect(choice.showSelector).toBe(true);
    expect(choice.selectedValue).toBe("2026-11-03");
    expect(choice.allowAll).toBe(false);
    expect(choice.note).toBe(
      "2 expiries were stored in the latest run (2026-10-27, 2026-11-03). The chain tabs show 2026-11-03, the newest book; OI history reads the nearest expiry of each session. Choose one to show it on every tab.",
    );
  });

  it("shows the user's choice, and says nothing once one has been made", () => {
    const choice = chooseExpiry({ expiries: [weekly("2026-10-27")], storedExpiries: [weekly("2026-10-27"), weekly("2026-11-03")] }, "2026-10-27");
    expect(choice.selectedValue).toBe("2026-10-27");
    expect(choice.showSelector).toBe(true);
    expect(choice.note).toBeNull();
  });

  it("sorts the options by date whatever order the API sent them in", () => {
    const choice = chooseExpiry({ expiries: [weekly("2026-11-03")], storedExpiries: [weekly("2026-11-03"), weekly("2026-10-27")] }, "");
    expect(choice.options.map((entry) => entry.expiryDate)).toEqual(["2026-10-27", "2026-11-03"]);
  });

  it("falls back to the response's own expiries when it names no menu, and keeps 'All expiries' for a response that holds several", () => {
    // A snapshot read from before the books were separate, or an API that predates the menu.
    const choice = chooseExpiry({ expiries: [weekly("2026-10-27"), weekly("2026-11-03")] }, "");
    expect(choice.options).toHaveLength(2);
    expect(choice.showSelector).toBe(true);
    expect(choice.allowAll).toBe(true);
    expect(choice.selectedValue).toBe("");
    expect(choice.note).toBeNull();
  });

  it("offers no selector when one expiry is stored, and nothing when there is no chain", () => {
    const single = chooseExpiry({ expiries: [weekly("2026-10-27")], storedExpiries: [weekly("2026-10-27")] }, "");
    expect(single.showSelector).toBe(false);
    expect(single.selectedValue).toBe("2026-10-27");
    expect(single.note).toBeNull();

    const none = chooseExpiry(null, "");
    expect(none).toEqual({ options: [], selectedValue: "", showSelector: false, allowAll: false, note: null });
  });
});
