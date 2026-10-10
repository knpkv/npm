## Building with rly

rly is a quiet, release-oriented design system: neutral surfaces, Geist type, state shown in words
plus an ink/tint pair. Every component is on `window.Rly` (for example `Rly.Button`, `Rly.Dialog.Root`).

### Wrap the app

Wrap the whole UI once in `ThemeProvider`. Its root carries `data-rly-root` and `data-theme`. rly's
reset, canvas background, text colour, Geist font and focus rings all hang off that root. Outside it,
components render with browser-default type and an unstyled page.

```jsx
<Rly.ThemeProvider theme="system">
  {" "}
  {/* "light" | "dark" | "system" */}
  <Rly.PortalProvider>
    {/* overlays (Dialog, Sheet, Select) portal into this tree */}
    <App />
  </Rly.PortalProvider>
</Rly.ThemeProvider>
```

A nested `ThemeProvider theme="dark"` themes just that subtree. Overlays need a `PortalProvider`
ancestor and render nothing without one. Links inside rly components go through `LinkProvider` when
the app has a router; without it they are native `<a>`.

### Style with props, then tokens

There are no utility classes. Components carry the design language through props:

- `Text` `variant`: `verdict`, `page-title`, `section-title`, `card-title`, `body-large`, `body`,
  `label`, `meta`, `code`. `tone`: `primary`, `secondary`, `tertiary`, `inherit`. Headings need
  `as="h1"` etc.
- `Button` `variant`: `primary`, `secondary`, `quiet`. `size`: `compact`, `dense`, `default`,
  `principal`. Also `leadingIcon`, `trailingIcon`, `loading`, `stretch`.
- `Surface` `tone`: `primary`, `secondary`, `tertiary`. `form`: `card`, `grouped`. `padding`:
  `none`, `compact`, `default`, `spacious`.
- State: `StateLabel` (`label` required) and `Notice`, `tone`: `positive`, `progress`, `caution`,
  `critical`, `neutral`. Always say the state in words; never signal it by colour alone.

For your own layout glue, use inline styles with rly's CSS custom properties, never raw colours:

- Space: `--rly-space-{0,2,4,6,8,12,16,20,24,32,40,48,64,80,96}`.
- Colour: `--rly-color-canvas`, `--rly-color-surface-{1,2,3}`, `--rly-color-text-{1,2,3}`,
  `--rly-color-border-{1,2}`, `--rly-color-focus`.
- Radius: `--rly-radius-{control,field,group,overlay,round,tag}`.

Colours are `light-dark()` pairs, so they follow the theme automatically. Service colours
(`--rly-color-service-jira` etc.) mark provider provenance only. Never use them for state or for
user-written links.

Never add a one-sided accent stripe (a thick or coloured left border) to a card, row or notice.
State goes in words, an even 1px border or a flat tint.

### Where the truth lives

`styles.css` and its imports hold every token and component style (`_ds_bundle.css`). Each
component's `.prompt.md` and `.d.ts` give its props; read them before composing an unfamiliar
pattern. The patterns (`ReleaseRow`, `EntityTable`, `Verdict`, `RelayPanel`, `DecisionBar`…) are
complete compositions: prefer one over rebuilding it from primitives.

### Example

```jsx
<Rly.ThemeProvider theme="system">
  <main style={{ display: "grid", gap: "var(--rly-space-24)", padding: "var(--rly-space-32)" }}>
    <Rly.Text as="h1" variant="page-title">
      Deployment approval
    </Rly.Text>
    <Rly.Text tone="secondary">Review the change before it reaches production.</Rly.Text>
    <Rly.Surface padding="default">
      <div style={{ display: "flex", gap: "var(--rly-space-8)", alignItems: "center" }}>
        <Rly.StateLabel label="Needs review" tone="caution" />
        <Rly.Button variant="primary">Approve</Rly.Button>
        <Rly.Button variant="quiet" trailingIcon="arrow-right">
          View detail
        </Rly.Button>
      </div>
    </Rly.Surface>
  </main>
</Rly.ThemeProvider>
```
