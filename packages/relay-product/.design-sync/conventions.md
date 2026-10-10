## Building Relay app screens

The Relay app is the fleet hub: approvals, the agent directory (Connect), Work goals, usage and the
Relay conversation dock. It is built from rly. Every screen piece here is on `window.RelayApp`; rly's
primitives and patterns (`Text`, `Button`, `Surface`, `Notice`, `StateLabel`) come from the rly design
system, and this project's styles already include rly's tokens and CSS.

### Wrap the screen

Wrap the whole screen once in `RelayApp.ThemeProvider` with `RelayApp.PortalProvider` inside it, exactly
as every card here is wrapped. Without it the pieces render with browser-default type.

```jsx
<RelayApp.ThemeProvider theme="system">
  <RelayApp.PortalProvider>
    <RelayApp.FleetShell /* hosts, tabs, children */ />
  </RelayApp.PortalProvider>
</RelayApp.ThemeProvider>
```

### Pick the piece by what the screen is

- The app frame: `FleetShell` (masthead, host count, the Approvals / Connect / Work / Usage tabs) with
  `RefreshStatus` under the masthead and `HubRelay` in it.
- Approvals: `DashboardView` (a host's page), `ApprovalsCountdown` (the queue with its clock),
  `ApprovalRequestDisclosure` (the full request behind a decision), `ActivityHistory`.
- Agents: `AgentCast` (the strip of characters that need you), `AgentStage` (one agent's panel),
  `Creature` (an agent's character), `AgentStateLabel`, `PinnedAgents`, `AgentActivity`.
- Work: `WorkBoard` (goals, their stages and approvals), `FleetWorkPanel` (the board's loading and
  failure states), `LanWorkPage` / `LanWorkPairPage` (the read-only LAN view and its pairing form).
- Usage: `UsageTab`, `ConnectLimits`.
- Relay conversation: `RelayConversationPanel` (the fleet conversation), `RelayProductDock`,
  `RelayProductPanel`, `RelayProductLauncher` (the per-product dock and its launcher).

Compose these; don't rebuild them from rly primitives. Each `.d.ts` gives the props, and each card's
cells show the states the product actually has: start from the closest cell.

### The product's rules

- State is said in words (Working, Waiting for you, Blocked, Stale), with an even 1px border or a flat
  tint. Never colour alone, never a one-sided accent stripe.
- Times and expiries are explicit ("4m 00s left", "Observed 2 minutes ago"); a stale reading says it is
  stale.
- Anything that changes the fleet (approve, reject, prompt an agent) is a deliberate button with the
  consequence spelled out under it, never an icon alone.
- Characters are identity, not decoration: one per agent, greyed when the agent's host stopped
  answering.
