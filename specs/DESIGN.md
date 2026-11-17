# Design system (from `prototype/receipts.html`)

The prototype is the source of truth. Port it to Next.js + Tailwind without redesigning. Clean white, black type, one green accent used only for "verified" and gains.

## Tokens (`tailwind.config.ts` → `theme.extend`)
```ts
colors: {
  bg: '#FFFFFF', 'bg-2': '#FAFAFA', 'bg-3': '#F4F4F5',
  line: '#EAEAEA', 'line-2': '#F1F1F2',
  ink: '#0A0A0A', 'ink-2': '#3F3F46', muted: '#71717A', faint: '#A1A1AA',
  green: { DEFAULT: '#12B76A', dark: '#067647', bg: '#ECFDF3' },
  red: { DEFAULT: '#D92D20', bg: '#FEF3F2' },
  ai: { DEFAULT: '#3538CD', bg: '#EEF4FF' },
},
fontFamily: {
  sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],   // all UI text
  mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],       // numbers, hashes, receipts
},
borderRadius: { btn: '11px', 'btn-lg': '13px', card: '16px', panel: '20px', frame: '18px', final: '28px' },
boxShadow: {
  sm: '0 1px 2px rgba(10,10,10,.04)',
  DEFAULT: '0 1px 2px rgba(10,10,10,.04), 0 8px 24px rgba(10,10,10,.06)',
  lg: '0 2px 4px rgba(10,10,10,.04), 0 24px 64px rgba(10,10,10,.10)',
},
```
Load fonts with `next/font/google` (Plus Jakarta Sans 400–800, Geist Mono 400–500).

## Type scale
| Use | Size / weight / tracking |
|---|---|
| Landing H1 | clamp(46px, 7vw, 86px) / 700 / −0.045em / line-height 1.02 |
| Section H2 | clamp(34px, 4.2vw, 52px) / 700 / −0.04em |
| App page H1 | 32px / 700 / −0.035em |
| Card title | 17–20px / 700 |
| Body | 16px / 400 / line-height 1.6; lede 17–19.5px muted |
| Eyebrow | 14px / 600 / green-dark (sentence case, not caps) |
| Numbers (KPIs, table numbers, balances) | Geist Mono 500 |

## Components to build (names match prototype classes)
- `Button` variants: `dark` (primary), `default` (white, border), sizes `sm`, `md`, `lg`. Arrow icon only on "Launch app".
- `Badge` (live pill with green dot + mono chip), `Tag` (`house` black, `ai` blue, neutral), `StatusPill` (`ok` green / `miss` red, dot prefix).
- Landing: `LandingNav` (sticky, blur, border on scroll), `Hero`, `ProductPreview` (browser frame + floating vault card + floating receipt), `BuiltOn`, `FeatureCards`, `HowItWorks` (clickable steps that highlight the matching receipt line), `SecurityList` + `WorstCaseCalculator`, `ComparisonTable`, `FAQ` (`<details>`), `FinalCTA`, `Footer`.
- App shell: `Sidebar` (logo, Menu group, active item = white card with ring, network card with live block, "Back to website"), `Topbar` (breadcrumb, wallet button), mobile: sidebar becomes a horizontal top bar.
- App: `KpiCard`, `SegmentedControl`, `StrategiesTable` (stacks into cards < 800px), `EquityChart` (SVG: strategy line green if return ≥ 0 else red, area gradient, dashed grey hold line, last-point dot), `ReceiptSlip` (full + compact; zigzag bottom via CSS mask; stamp "Matches commit" green / "Reveal missed" red), `CopyPanel`, `OnChainFacts` (key/value list), `VaultSetup` (range sliders, asset chips), `VaultDashboard` (balance, status pill, deposit/withdraw, limit meters, activity log), `VerifyForm` + `ChecksList`, `Toast`.

## Receipt slip CSS (keep exactly)
```css
.slip{ --z:7px; background:#fff; font-family:'Geist Mono'; font-size:12.5px; line-height:1.85;
  -webkit-mask: linear-gradient(#000 0 0) top/100% calc(100% - var(--z)) no-repeat,
                conic-gradient(from -45deg at bottom,#0000,#000 1deg 89deg,#0000 90deg) bottom/calc(2*var(--z)) var(--z) repeat-x;
          mask: (same) }
.slipwrap{ filter: drop-shadow(0 0 .6px rgba(10,10,10,.35)) drop-shadow(0 10px 24px rgba(10,10,10,.08)); }
```

## Motion
Only: hero preview rises in once on load (0.9 s), floating cards follow with 0.25 s / 0.4 s delay; hover lift 2 px on receipts; toast slide. Respect `prefers-reduced-motion`.

## Copy rules
Sentence case. Buttons say exactly what happens ("Create vault", "Deposit", "Check receipt", "Revoke bot access"). Errors say what went wrong and how to fix it. Never claim "AI" for rule-based templates. Always show "Not investment advice" in the footer.
