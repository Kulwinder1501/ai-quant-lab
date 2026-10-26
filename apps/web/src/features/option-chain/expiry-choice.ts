/**
 * Which expiries the page can show, and which one the selector reads. Pure, no React.
 *
 * Around an expiry the collector stores two books per run, one per expiry (the nearest, and the tradable one), each under its own
 * instant a fraction of a second apart. A chain read with no expiry returns only the one written last, so for a day or two each
 * expiry cycle the page showed the far expiry while the selector, which only appeared when a single response held several expiries,
 * stayed hidden and the user had no way to see the other. The API now names every expiry the run stored (`storedExpiries`); this
 * decides what the selector offers.
 *
 * The defaults are not changed here. With nothing chosen the chain tabs show the book the API returns (the one written last) and
 * OI history reads the nearest expiry of each session. A choice made in the selector is passed to every tab and to the live stream.
 */

export interface ExpiryEntry {
  expiryDate: string;
  expiryKind: string;
}

export interface ExpiryChoice {
  /** What the selector offers, in date order: the expiries stored in the run, or the response's own when it names none. */
  options: ExpiryEntry[];
  /** The value the selector shows: the user's choice, else the response's single expiry, else "" (all of them). */
  selectedValue: string;
  /** Whether there is anything to choose between. */
  showSelector: boolean;
  /** "All expiries" is only a real choice when one response holds more than one. */
  allowAll: boolean;
  /** One sentence saying what each tab shows while nothing is chosen, or null when it need not be said. */
  note: string | null;
}

interface ChainExpiries {
  expiries?: ExpiryEntry[];
  storedExpiries?: ExpiryEntry[];
}

export function chooseExpiry(chain: ChainExpiries | null, selected: string): ExpiryChoice {
  const responseExpiries = chain?.expiries ?? [];
  const stored = chain?.storedExpiries ?? [];
  const options = (stored.length > 0 ? stored : responseExpiries).slice().sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const single = responseExpiries.length === 1 ? responseExpiries[0]!.expiryDate : "";
  const showSelector = options.length > 1;
  const note = showSelector && selected === "" && single !== ""
    ? `${options.length} expiries were stored in the latest run (${options.map((entry) => entry.expiryDate).join(", ")}). The chain tabs show ${single}, the newest book; OI history reads the nearest expiry of each session. Choose one to show it on every tab.`
    : null;
  return {
    options,
    selectedValue: selected || single,
    showSelector,
    allowAll: responseExpiries.length > 1,
    note,
  };
}
