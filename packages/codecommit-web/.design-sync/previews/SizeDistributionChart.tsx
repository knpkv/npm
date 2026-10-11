// Fixtures from packages/codecommit-core/test/StatsService.test.ts.
import { SizeDistributionChart, ThemeProvider } from "@knpkv/codecommit-web-design-system"
import { emptySize } from "../fixtures/stats.js"

/** The tests provide an empty diff-size distribution. */
export const Empty = () => <SizeDistributionChart dist={emptySize} />
/** The same no-data state in the dark theme. */
export const EmptyDark = () => <ThemeProvider theme="dark"><div className="dark" style={{ padding: 16, background: "var(--rly-color-canvas)", color: "var(--rly-color-text-1)" }}><SizeDistributionChart dist={emptySize} /></div></ThemeProvider>
