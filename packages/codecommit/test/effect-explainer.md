# Effect Explainer: Testing TUI Components

Extract pure logic, test with `@effect/vitest`, keep React out of unit tests.

## Strategy

```
┌─────────────────────────────────────────────────┐
│  React Component (Table.tsx)                    │
│  Rendering, refs, useEffect — NOT unit-tested   │
│  (integration/visual tests cover this)          │
└──────────────────┬──────────────────────────────┘
                   │ imports
┌──────────────────▼──────────────────────────────┐
│  Pure Functions (exported from same file)       │
│  computeScrollTarget, resolveColumnLayout       │
│  Constants: ROW_HEIGHT, SCROLL_LEAD             │
│  ← THESE are unit-tested                        │
└─────────────────────────────────────────────────┘
```

## `it` vs `it.effect`

```typescript
// Pure computation → plain `it`
it("clamps to 0", () => {
  expect(computeScrollTarget(0)).toBe(0)
})

// Effectful computation → `it.effect` + Effect.gen
it.effect("decodes schema", () =>
  Effect.gen(function* () {
    const result = yield* Schema.decode(MySchema)(input)
    expect(result.field).toBe("value")
  })
)
```

Rule: only use `it.effect` when the code under test returns an `Effect`.
Wrapping pure functions in Effect adds noise without value.

## Extracting Testable Logic from Components

Extract testable logic from components as pure functions with named constants:

```typescript
export const ROW_HEIGHT = 2
export const SCROLL_LEAD = 2
export const computeScrollTarget = (index, rowHeight = ROW_HEIGHT, scrollLead = SCROLL_LEAD) =>
  Math.max(0, (index - scrollLead) * rowHeight)

export function Table({ selectedIndex }) {
  useEffect(() => {
    scrollRef.current.scrollTo({ x: 0, y: computeScrollTarget(selectedIndex) })
  }, [selectedIndex])
}
```

Now `computeScrollTarget` is testable without React, and the component
reads as a simple wiring of pure functions to DOM effects.

## Test Comment Convention

Every test gets a comment _above_ explaining **why** it exists:

```typescript
// When the selected row is within the lead range (indices 0, 1),
// scrolling up would go negative — must clamp to 0.
it("clamps to 0 when selectedIndex <= scrollLead", () => { ... })
```

This serves as living documentation: if the test fails, the comment
tells you whether the behavior change is intentional or a regression.

## Test Layering in This Project

| Layer       | Tool                    | What it tests                            |
| ----------- | ----------------------- | ---------------------------------------- |
| Unit        | `@effect/vitest` + `it` | Pure functions, Schema decode/encode     |
| Unit        | `it.effect`             | Effectful services (ConfigService, etc.) |
| Integration | `it.layer`              | Service composition with mock layers     |

TUI components live at the rendering layer — they're tested via the
pure functions they call, not by mounting JSX.
