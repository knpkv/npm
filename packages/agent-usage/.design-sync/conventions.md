## Building agent-usage screens

agent-usage shows what coding agents cost and how close each provider's limits are: a limits summary,
limits over time, usage per day stacked by booking (a ticket or repository), and the bookings table.
It is built from rly. Every piece here is on `window.AgentUsage`; rly's primitives come from the rly
design system, and this project's styles already include rly's tokens and CSS.

### Wrap the screen

Wrap the screen in `AgentUsage.ThemeProvider` with `AgentUsage.PortalProvider` inside it, then the
page frame: a `div.usage-shell` with a `main.usage-app` inside. The chart series colours are scoped to
`.usage-shell`; outside it, bars and booking swatches lose their colours.

```jsx
<AgentUsage.ThemeProvider theme="system">
  <AgentUsage.PortalProvider>
    <div className="usage-shell">
      <main className="usage-app">
        <AgentUsage.LimitsSummary /* balances, latest, now */ />
        <AgentUsage.UsageChart /* periods, stacked, slots, measure="cost" */ />
        <AgentUsage.BookingTable /* bookings, named, slots */ />
      </main>
    </div>
  </AgentUsage.PortalProvider>
</AgentUsage.ThemeProvider>
```

### The pieces

- `LimitsSummary`: each provider's limits now, with the binding one called out in words.
- `LimitChart`: limits over the range, one row per limit, with the 80% mark and unread gaps keyed.
- `UsageChart`: cost or tokens per period, stacked by booking; `TokenUsageChart` fixes the measure to
  tokens for surfaces that never show money.
- `BookingTable`: bookings with their series swatch, agents, requests, tokens and cost; sortable.
- `StatusStrip`: the machine, the ingest pass and any ignored keys, at the foot of the page.
- `LiveIndicator`: whether live updates are flowing, and the age of the last one.

### The product's rules

- A limit's state is said in words ("At limit", "Near limit", "Stale, read 4d ago"), never by colour
  alone. A stale reading is hatched and says it is stale.
- A booking keeps one colour everywhere it appears: the chart, the legend and the table share the
  same slot. Past eight bookings, the rest fold into Other; never invent a ninth colour.
- Money is labelled as an API-equivalent cost; token-only surfaces use `TokenUsageChart`.
- No one-sided accent stripes; an even 1px border or a flat tint.
