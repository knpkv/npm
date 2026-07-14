import { Button, Field, Surface, Text } from "@knpkv/rly/primitives"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { type FormEvent, type ReactElement, useState } from "react"
import { useNavigate } from "react-router"

import { makeControlCenterApiClient } from "../api/client.js"
import { PairingCode } from "../api/session.js"
import { useBrowserSession } from "./BrowserSession.js"
import { pairingFailureMessage } from "./PairingFailure.js"
import styles from "./pages.module.css"

const pairBrowser = (rawPairingCode: string) =>
  Effect.gen(function* () {
    const pairingCode = yield* Schema.decodeUnknownEffect(PairingCode)(rawPairingCode.trim())
    const client = yield* makeControlCenterApiClient()
    return yield* client.session.pair({ payload: { pairingCode } })
  }).pipe(Effect.provide(FetchHttpClient.layer))

/** Pair the current tab without ever exposing the opaque session cookie to JavaScript. */
export const PairPage = (): ReactElement => {
  const navigate = useNavigate()
  const { setState } = useBrowserSession()
  const [pairingCode, setPairingCode] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [isPairing, setIsPairing] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setError(undefined)
    setIsPairing(true)
    Effect.runPromise(pairBrowser(pairingCode)).then(
      (result) => {
        sessionStorage.setItem("cc_csrf", result.csrfToken)
        setState({ _tag: "authenticated", session: result.session })
        navigate("/", { replace: true })
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
          Use the one-time code printed by the local Control Center server. It expires after ten minutes.
        </Text>
      </header>
      <Surface as="section" className={styles.pairCard} padding="spacious" shape="grouped" tone="secondary">
        <form className={styles.pairForm} onSubmit={submit}>
          <Field
            description="The code stays in this request and is never placed in a URL."
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
