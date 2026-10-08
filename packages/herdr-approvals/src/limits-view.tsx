/**
 * Claude and Codex subscription limits: one compact chip per provider for the masthead, and the
 * "Usage limits" panel. Both render a {@link LimitsView}; neither reads a clock or the network.
 *
 * @module
 */
import { LimitTrack, StateLabel, Surface, Text, type RlyStateTone } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"
import {
  headlineWindow,
  type LimitAccountView,
  type LimitProviderId,
  type LimitTone,
  limitProviders,
  limitToneLabel,
  type LimitsView,
  type LimitWindowView
} from "./limits-model.js"

/** The panel heading's id: a chip moves focus here, which also scrolls it into view. */
export const limitsPanelHeadingId = "usage-limits"

const stateTone = {
  ok: "positive",
  near: "caution",
  "at-limit": "critical",
  unknown: "neutral"
} satisfies Record<LimitTone, RlyStateTone>

const percent = (window: LimitWindowView): string => (window.value === null ? "unknown" : `${String(window.value)}%`)

/** "Claude" plus every account's headline window, the closest to its limit first. */
const providerHeadlines = (
  view: LimitsView
): ReadonlyArray<{ readonly provider: LimitProviderId; readonly name: string; readonly window: LimitWindowView }> =>
  limitProviders.flatMap((provider) => {
    const accounts = view.accounts.filter((account) => account.provider === provider)
    const window = headlineWindow(accounts.flatMap((account) => (account.headline === null ? [] : [account.headline])))
    const name = accounts[0]?.name
    return window === null || name === undefined ? [] : [{ provider, name, window }]
  })

/**
 * One chip per provider, for the masthead: "Claude 47% weekly". The window word drops on a phone.
 * Each links to the panel; `onOpen` lets the shell show the tab the panel is on first.
 */
export const LimitsChips = ({
  onOpen,
  view
}: {
  readonly onOpen?: () => void
  readonly view: LimitsView
}): ReactElement | null => {
  const headlines = providerHeadlines(view)
  if (headlines.length === 0) return null
  return (
    <nav aria-label="Usage limits" className="limits-chips">
      {headlines.map(({ name, provider, window }) => (
        <a
          className="limits-chip"
          data-tone={window.tone}
          href={`#${limitsPanelHeadingId}`}
          key={provider}
          onClick={(event) => {
            if (onOpen === undefined) return
            event.preventDefault()
            onOpen()
          }}
        >
          <StateLabel label={`${name} ${percent(window)}`} size="compact" tone={stateTone[window.tone]} />
          <span className="limits-chip-window">{window.name.toLowerCase()}</span>
        </a>
      ))}
    </nav>
  )
}

const WindowRow = ({ window }: { readonly window: LimitWindowView }) => {
  // An unknown window has no number: its reason takes the number's place.
  const used = window.value === null ? window.detailText : window.usedText
  const details = [window.value === null ? null : window.detailText, window.paceText, window.sourceText].filter(
    (part): part is string => part !== null
  )
  return (
    <li className="limits-window" data-tone={window.tone}>
      <Text className="limits-window-name" variant="label">
        {window.name}
      </Text>
      {/* Decorative: the words beside it carry the number, the old-reading note and the pace. */}
      <LimitTrack
        className="limits-window-track"
        near={window.reserveMark}
        stale={window.stale}
        value={window.value}
        {...(window.projected === null ? {} : { projected: window.projected })}
      />
      <Text className="limits-window-used" variant="meta">
        {used}
      </Text>
      <StateLabel
        className="limits-window-state"
        label={limitToneLabel[window.tone]}
        size="compact"
        tone={stateTone[window.tone]}
      />
      {details.length === 0 ? null : (
        <Text className="limits-window-detail" tone="secondary" variant="meta">
          {details.join("; ")}
        </Text>
      )}
    </li>
  )
}

const Account = ({ account }: { readonly account: LimitAccountView }) => (
  <section className="limits-account" aria-label={account.account === null ? account.name : `${account.name}, ${account.account}`}>
    <div className="limits-account-heading">
      <Text as="h3" variant="label">
        {account.name}
      </Text>
      {account.account === null ? null : (
        <Text className="limits-account-label" tone="secondary" variant="meta">
          {account.account}
        </Text>
      )}
    </div>
    {account.windows.length === 0 ? (
      <Text tone="secondary" variant="meta">
        No windows reported
      </Text>
    ) : (
      <ul className="limits-windows">
        {account.windows.map((window) => (
          <WindowRow key={window.key} window={window} />
        ))}
      </ul>
    )}
  </section>
)

/**
 * The "Usage limits" panel. `problem` says why the latest load failed; the last good view stays
 * shown under it. Without any view yet, the panel says it is still reading.
 */
export const LimitsPanel = ({
  problem = null,
  view
}: {
  readonly problem?: string | null
  readonly view: LimitsView | null
}): ReactElement => (
  <Surface as="section" className="limits-panel" padding="spacious" aria-labelledby={limitsPanelHeadingId}>
    <div className="section-heading">
      <Text as="h2" id={limitsPanelHeadingId} tabIndex={-1} variant="section-title">
        Usage limits
      </Text>
    </div>
    {problem === null ? null : (
      <Text className="notice" tone="secondary">
        {problem}
      </Text>
    )}
    {view === null ? (
      problem === null ? (
        <Text tone="secondary">Reading limits</Text>
      ) : null
    ) : (
      <>
        {view.accounts.length === 0 ? <Text tone="secondary">No host reports limits yet.</Text> : null}
        <div className="limits-accounts">
          {view.accounts.map((account) => (
            <Account account={account} key={account.key} />
          ))}
        </div>
        {view.notes.length === 0 ? null : (
          <ul className="limits-notes">
            {view.notes.map((note) => (
              <li key={note}>
                <Text tone="secondary" variant="meta">
                  {note}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </>
    )}
  </Surface>
)
