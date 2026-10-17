---
title: UI Consistency
input: incremental
tools:
  - browse_code
  - modify_pr
include:
  - "packages/*/src/**/*.tsx"
  - "packages/*/src/**/*.css"
exclude:
  - "**/generated/**"
  - "**/vendor/**"
  - "packages/rly/src/styles/generated-tokens.css"
maxBudgetPerRun: 2
maxBudgetPerPR: 10
conclusion: neutral
---

# UI consistency review

This is a styling and composition guard, not a general review. Review only the changed lines and answer the
questions below. Do not build the project, inspect emitted CSS, trace selector consumers across the codebase or
ask for screenshots. If the diff does not make a violation obvious, there is no finding.

Out of scope, because other gates own them:

- whether a screen matches its design: the design-conformance gate compares live screens with the Claude Design
  refs under `design-refs/`;
- pixel changes: the visual workflows and their `visual-change-approved` label;
- anything the CSS ast-grep rules in `ast-grep/rules/css` or the Rly lints (`lint:rly-colors`,
  `lint:rly-focus-rings`, `lint:rly-stripes`, `lint:rly-css-tokens`) already report, such as physical properties,
  hover outside a hover media query, removed outlines, motion without opt-in and one-sided stripes.

`packages/codecommit-web` follows section 4 instead of sections 1 and 2. Inside `packages/rly/src`, the primitives
themselves are the implementation and may render raw elements.

## 1. Rly primitives over raw controls

Product UI uses the primitives exported from `packages/rly/src/primitives` (`Button`, `IconButton`, `Field`,
`Select`, `ToggleGroup`, `Tabs`, `Dialog`, `Sheet`, `Notice`, `Surface`, `Text` and the rest of that directory)
and the patterns in `packages/rly/src/patterns`, instead of rebuilding them.

- Flag a raw `<button>`, `<input>`, `<select>` or `<textarea>` styled to look like a control when the matching
  primitive exists.
- Flag a call site that overrides a primitive's height, radius, padding, focus ring or base colours with its own
  class. When several places need the same look, the fix is a variant on the primitive.
- Do not flag raw elements that are deliberately not a primitive: semantic rows, canvas nodes, resize handles,
  swatches, editor surfaces, or anything whose behaviour or geometry differs by design.

## 2. CSS modules, Rly tokens and good CSS

Styling lives in the component's CSS module and uses Rly tokens.

- Flag raw colours (hex, `rgb()`, `hsl()`, named colours) and raw sizes, spacing, radii or font sizes where a Rly
  token exists. Theme-dependent values use the token set with `light-dark()`, not per-theme selectors.
- Flag a new `style={{ … }}` object or inline `<style>` carrying static values. Values computed at runtime, such as
  a position or a measured size, are fine.
- The parent owns spacing: flag margins on children used to space siblings where the parent could use `gap`.
- Flag an interactive element whose hit area is below 44px with no `::after` extension, and a focus style that
  relies on colour alone.
- Lengths are in `em` or `rem` tokens, not `ch`, `ex`, `cap` or `ic`. Local custom properties take a non-`--rly-`
  prefix.

## 3. Composable components

The reference is Rly's `Dialog` in `packages/rly/src/primitives/Dialog.tsx`: one frozen object of small slot
components (`Dialog.Root`, `Dialog.Trigger`, `Dialog.Content`, `Dialog.Close`). Each slot owns its own CSS module
classes, spreads the remaining props, and merges a caller's `className` with `classNames` so callers adjust
without overriding. Variants such as `size` are declared once with `defineVariants` and chosen by prop, not by ad
hoc classes at call sites. Where a slot needs a control it renders Rly's `Button`. Pages built from named content
regions take them as slot props, as `EntityShell` in `packages/rly/src/patterns/EntityShell.tsx` does.

- Flag a new component that copies a chunk of an existing primitive's or pattern's markup and classes instead of
  composing or extending it.
- Flag a one-off class on a shared component that repeats a treatment another call site already uses. The fix is
  a variant or a slot on the shared component.

## 4. `packages/codecommit-web`: Tailwind and its own primitives

This package styles with Tailwind and has its own primitives in `packages/codecommit-web/src/client/components/ui`
(`button`, `input`, `dialog`, `dropdown-menu`, `badge`, `card` and the rest of that directory).

- Flag a raw control styled to look like one of those primitives, and a call site overriding a primitive's base
  geometry or colours with its own class string; the fix is a variant on the primitive.
- Styling lives as Tailwind classes on the element that renders it, merged with `cn` from `src/client/lib/utils.ts`.
  Flag new rules in a global stylesheet when the same styling could be classes on the owner, arbitrary colour
  values such as `bg-[#…]` where a theme colour exists, and static inline styles.

## Reporting

Report only violations introduced by changed lines. Post each as one brief inline comment on the relevant line:
name the rule, name the primitive, token or location the code should use instead, and stop. Do not comment on
class ordering, aesthetic preference or untouched legacy code, and do not ask for cleanup outside the pull
request's scope.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.
