# UI motion system

## Purpose

The interface refresh gives the local research dashboard a calmer, more
intentional sense of movement without changing what the application does. It
must make stored market evidence easier to inspect; it must not make a scanner
result look like a live quote, a prediction look like a trade instruction, or
an animation look like new data.

The design has two deliberately separate parts:

- **Direct Lenis integration** for optional smooth document scrolling.
- **Source-owned React and Tailwind primitives** for small reveals, glass
  surfaces, decorative backgrounds, and progress affordances.

The latter may take visual and interaction inspiration from Inspira UI and
Animate UI, but stays in this repository. It does not wrap, copy, or depend on
either component library at runtime.

## Current app shape

The motion boundary belongs entirely in `apps/web`; it does not cross into the
API, ML, scanner, strategy, paper-trading, or broker boundaries.

```text
apps/web/src/
  app/
    layout.tsx                         # imports Lenis CSS; installs one root provider
    globals.css                        # Tailwind entry point and global base styles
    page.tsx                           # scanner route entry
    predictions/page.tsx               # predictions route entry
  components/ui/
    smooth-scroll.tsx                  # direct lenis/react client integration
    reveal.tsx                         # intersection-based Reveal and Stagger primitives
    aurora-backdrop.tsx                # decorative, aria-hidden CSS surface
    glass-panel.tsx                    # reusable static/interactive panels
    scroll-progress.tsx                # decorative, aria-hidden scroll affordance
    class-names.ts                     # tiny class composition helper
  features/
    research/
      api.ts                           # explicit GET-only transport
      json.ts, presentation.ts         # defensive parsing and shared display helpers
      components/                      # shell, navigation, boundary, request states
    scanner/
      api.ts, domain.ts                # scanner/watchlist parsing and view contract
      components/                      # dashboard, watchlist, and scanner evidence cards
    predictions/
      api.ts, domain.ts                # prediction parsing and view contract
      components/                      # dashboard, list, and explanation inspector
```

Keep data parsing and fetching inside the relevant feature dashboard modules.
The shared primitives should accept visual props and `children`, not API URLs,
prediction objects, trading state, or callbacks that can mutate research data.

## Lenis: one direct, optional root integration

`app/layout.tsx` imports `lenis/dist/lenis.css` and wraps the application once
with the client-side `SmoothScroll` component. `SmoothScroll` imports
`ReactLenis` directly from `lenis/react`; there is no adapter layer or
third-party motion wrapper between the app and Lenis.

The intended lifecycle is:

1. Render ordinary native scrolling during server rendering and the first
   client render.
2. Read `prefers-reduced-motion` after hydration.
3. Keep native scrolling when reduced motion is requested.
4. Otherwise mount one root `ReactLenis` instance with `autoRaf`, anchor
   support, conservative interpolation, and no touch-scroll surprise.
5. Subscribe to media-query changes so a user can turn motion off while the
   page is open.

This keeps scrolling progressive: a browser that cannot run the enhancement,
a user who blocks scripts, or a user who requests reduced motion still gets a
complete native-scrolling dashboard. Do not create a Lenis instance per card,
route, modal, or fetch result. Do not replace keyboard focus, native links,
or browser history scrolling with custom animation.

Useful official references:

- [Lenis website and documentation](https://www.lenis.dev/)
- [Lenis source, React package, options, and CSS guidance](https://github.com/darkroomengineering/lenis)

## Source-owned primitives, with compatibility first

Inspira UI and Animate UI are useful references for composition, restrained
entrance motion, and polished feedback. Their role here is inspiration, not a
new runtime dependency or a copied design system. The compatible baseline is
plain React, Tailwind utilities, small browser APIs, and CSS:

| Primitive | Responsibility | Compatibility rule |
| --- | --- | --- |
| `Reveal` / `Stagger` | Optional entrance affordance for already-rendered content | Use opacity/transform only; render visible immediately for reduced motion or unsupported observers. |
| `AuroraBackdrop` / `ResearchGrid` | Decorative visual depth | Must be `aria-hidden`, pointer-events-none, and never carry information. |
| `GlassPanel` / `InteractiveGlassCard` | Consistent readable grouping and hover feedback | Keep focus-visible styles; hover is enhancement only; remove transforms/transitions under reduced motion. |
| `ScrollProgress` | Decorative reading-position cue | Keep `aria-hidden`; it must never announce, fetch, or alter state. |
| `SmoothScroll` | Optional document scroll enhancement | Mount once, client-side, and fall back to the native browser path. |

When adding a primitive:

- Prefer CSS/Tailwind over a large animation dependency.
- Prefer composable semantic HTML over visual-only `div` trees.
- Keep the public prop surface small and source-owned.
- Feature-detect browser APIs such as `IntersectionObserver`; if unavailable,
  show content rather than leaving it hidden.
- Avoid animating layout-critical properties or anything that changes content
  order, focus order, prices, timestamps, confidence, or request state.
- Do not use motion to conceal loading, failure, empty, or stale-data states.

Reference galleries:

- [Inspira UI](https://inspira-ui.com/)
- [Animate UI](https://animate-ui.com/)
- [Tailwind motion-safe and motion-reduce variants](https://tailwindcss.com/docs/hover-focus-and-other-states#prefers-reduced-motion)

## Accessibility and reduced-motion contract

Motion is strictly progressive enhancement.

- Respect `prefers-reduced-motion: reduce` both in JavaScript and CSS. The
  current primitives use `matchMedia` for Lenis and Tailwind's
  `motion-reduce:` variants for visual effects.
- With reduced motion, do not smooth-scroll, pulse, translate, stagger, or
  delay meaningful content. Render it in its final visible state.
- Keep normal keyboard navigation, skip/link behavior, focus-visible rings,
  browser find-in-page, text selection, and native scrolling intact.
- Never put required state in color, opacity, position, or animation alone.
  Loading, empty, unavailable, research-only, and recorded-close labels remain
  textual.
- Decorative layers must be hidden from the accessibility tree. Interactive
  panels retain semantic controls and visible focus treatment.
- Check contrast through translucent panels and disable nonessential effects
  on constrained devices rather than reducing text legibility.

Before merging a visual change, test keyboard-only navigation, a reduced-motion
browser setting, a narrow viewport, JavaScript-disabled/native-scroll behavior
where practical, and a route transition between scanner and predictions.

## Data and safety boundary

The refresh is presentation-only. It must preserve the dashboard's existing
read-only contract:

- Scanner/watchlist reads use only `GET /api/v1/watchlist` and
  `GET /api/v1/market-scanner`.
- Prediction inspection uses only `GET /api/v1/model-predictions` and
  `GET /api/v1/model-predictions/:id`.
- No visual primitive creates, updates, evaluates, promotes, or deletes
  predictions, strategies, instruments, trade ideas, paper activity, broker
  activity, or orders.
- Motion must never trigger a refetch by itself; explicit dashboard effects
  retain ownership of their existing GET requests and defensive parsers.

The scanner and prediction screens therefore remain research inspection views.
Smooth scrolling, reveal effects, and polished panels do not turn recorded
evidence into live data or automated action.

## Acceptance checklist

- [ ] Exactly one direct root Lenis integration exists and native scrolling is
      the fallback.
- [ ] Every motion primitive has a clear reduced-motion final state.
- [ ] Unsupported browser APIs reveal content rather than hiding it.
- [ ] Decorative effects are excluded from the accessibility tree.
- [ ] Focus, keyboard navigation, and route links work without animation.
- [ ] Scanner and prediction network traffic remains GET-only.
- [ ] No new runtime dependency is introduced solely to reproduce an
      Inspira UI or Animate UI visual.
- [ ] A browser build succeeds and the existing API read-only tests remain
      unchanged.
