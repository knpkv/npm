## Building CodeCommit web screens

CodeCommit web is the browser view of a CodeCommit review queue: pull requests that need a decision,
their diffs and approvers, Relay reviews, sandboxes, team stats and settings. It is built from rly plus
Tailwind utilities. Every piece here is on `window.CodeCommitWeb`; rly's primitives come from the rly
design system, and this project's styles already include rly's tokens, the cascade layer order and the
app theme.

### Wrap the screen

Wrap the screen in `CodeCommitWeb.ThemeProvider` with `CodeCommitWeb.PortalProvider` inside it, then
`CodeCommitWeb.MemoryRouter`: rows and rail entries are router links and need a router above them.

```jsx
<CodeCommitWeb.ThemeProvider theme="system">
  <CodeCommitWeb.PortalProvider>
    <CodeCommitWeb.MemoryRouter>
      <CodeCommitWeb.WorkbenchRailView /* queue, currentUser, currentKey */ />
    </CodeCommitWeb.MemoryRouter>
  </CodeCommitWeb.PortalProvider>
</CodeCommitWeb.ThemeProvider>
```

### The pieces

- Queue: `PRRow` (one pull request: state, review ownership, health, repository, author, activity),
  `WorkbenchRailView` (the rail beside an open pull request), `FilterSelectionIndicator`,
  `DateRangePicker`, `RollingStatus` (the refresh progress line).
- Review: `FindingsDrawer` (the findings panel beside or over the diff).
- Sandboxes: `SandboxesPageView`, `SandboxViewContent`.
- Stats: `KPICard`, `RankingChart`, `SizeDistributionChart`, `MostActivePRs`, `StalePRs`, `HealthCard`.
- Settings: `SettingsRelayView`, `SettingsSandboxView`, `SettingsNotifications`, `SettingsTheme`,
  `SettingsAbout`, and `ConfigUnavailableView` for a settings read that failed.

The full pull request page, the queue page and the review workspace are not here yet; compose from these
pieces and rly rather than rebuilding them.

### The product's rules

- A pull request's state is said in words (Pending, Approved, Conflict, Merged, Closed, or approval
  unknown with its reason), with "Needs your review" when it is yours to decide; never colour alone.
  Unknown approval is never counted as waiting on you.
- Provider colours (the CodeCommit mark, a revision label) mark provider-owned facts only; titles,
  descriptions and other user-written text use the plain text and action tokens.
- Times are explicit; a failed or stale read says so and offers to read again.
- No one-sided accent stripes; an even 1px border or a flat tint.
