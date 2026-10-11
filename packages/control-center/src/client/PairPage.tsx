import { Button, Field, Surface, Text } from "@knpkv/rly/primitives"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { type FormEvent, type ReactElement, useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"

import { makeControlCenterApiClient } from "../api/client.js"
import { PairingCode, type PairSessionResponse } from "../api/session.js"
import type { BootstrapPairing } from "./bootstrapHandoff.js"
import type { ProviderId } from "../domain/sourceRevision.js"
import { useBrowserSession } from "./BrowserSession.js"
import { pairingFailureMessage } from "./PairingFailure.js"
import { selectedServiceProvider, serviceSetupPath } from "./services/serviceOnboarding.js"
import styles from "./pages.module.css"

const pairBrowser = Effect.fn("PairPage.pairBrowser")((rawPairingCode: string) =>
  Effect.gen(function* () {
    const pairingCode = yield* Schema.decodeUnknownEffect(PairingCode)(rawPairingCode.trim())
    const client = yield* makeControlCenterApiClient()
    return yield* client.session.pair({ payload: { pairingCode } })
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

/**
 * Promise edge for the terminal fragment handoff. It lives in this lazy route chunk so the
 * generated API client stays out of the initial bundle; the code is decoded before any request.
 */
export const exchangeBootstrapCode = (code: string): Promise<PairSessionResponse> =>
  Effect.runPromise(pairBrowser(code))

/** Preserve explicit service onboarding while ordinary pairing resolves workspace settings. */
export const pairedBrowserDestination = (selectedProvider: ProviderId | null): string =>
  selectedProvider === null ? "/" : serviceSetupPath(selectedProvider)

/** Pair the current tab without ever exposing the opaque session cookie to JavaScript. */
export const PairPage = ({
  bootstrapPairing
}: { readonly bootstrapPairing?: BootstrapPairing | null } = {}): ReactElement => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { establishSession } = useBrowserSession()
  const [pairingCode, setPairingCode] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [isPairing, setIsPairing] = useState(false)

  useEffect(() => {
    const pending = bootstrapPairing?.pair()
    if (pending === undefined || pending === null) return
    let current = true
    setIsPairing(true)
    pending.then(
      (result) => {
        if (!current) return
        establishSession(result.csrfToken, result.session)
        navigate(pairedBrowserDestination(selectedServiceProvider(searchParams, "service")), { replace: true })
      },
      (failure) => {
        if (!current) return
        setError(pairingFailureMessage(failure))
        setIsPairing(false)
      }
    )
    return () => {
      current = false
    }
  }, [bootstrapPairing, establishSession, navigate, searchParams])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setError(undefined)
    setIsPairing(true)
    Effect.runPromise(pairBrowser(pairingCode)).then(
      (result) => {
        establishSession(result.csrfToken, result.session)
        const selectedProvider = selectedServiceProvider(searchParams, "service")
        navigate(pairedBrowserDestination(selectedProvider), { replace: true })
      },
      (failure) => {
        setError(pairingFailureMessage(failure))
        setIsPairing(false)
      }
    )
  }

  return (
    <section aria-labelledby="pair-title" className={styles.page}>
      <header className={styles.sectionHeading}>
        <Text as="h1" id="pair-title" variant="page-title">
          Pair this browser
        </Text>
        <Text tone="secondary" variant="body-large">
          Manual pairing codes expire after ten minutes. Terminal sign-in links expire after one minute.
        </Text>
      </header>
      <Surface as="section" className={styles.pairCard} padding="spacious" form="grouped" tone="secondary">
        <form className={styles.pairForm} onSubmit={submit}>
          <Field
            description="Manual codes stay in this request. Terminal sign-in links use a fragment cleared before pairing."
            label="Pairing code"
            required
            {...(error === undefined ? {} : { error })}
          >
            {(controlProps) => (
              <input
                {...controlProps}
                autoComplete="one-time-code"
                inputMode="text"
                maxLength={64}
                onChange={(event) => setPairingCode(event.currentTarget.value)}
                spellCheck={false}
                value={pairingCode}
              />
            )}
          </Field>
          <Button
            disabled={pairingCode.trim().length !== 64}
            loading={isPairing}
            size="principal"
            type="submit"
            variant="primary"
          >
            Pair browser
          </Button>
        </form>
      </Surface>
    </section>
  )
}
