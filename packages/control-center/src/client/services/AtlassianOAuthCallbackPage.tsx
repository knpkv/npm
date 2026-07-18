import { Button, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { type ReactElement, useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"

import { AtlassianOAuthGrantId, type AtlassianOAuthGrantExchangeResponse } from "../../api/plugins.js"
import { useBrowserSession } from "../BrowserSession.js"
import { browserConnectionTestTransport, type ConnectionTestTransport } from "./connectionTestTransport.js"
import styles from "./AtlassianOAuthCallbackPage.module.css"

const AuthorizationCode = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096))

type CallbackState =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "exchanging" }
  | { readonly _tag: "selecting"; readonly grant: AtlassianOAuthGrantExchangeResponse; readonly saveFailed: boolean }
  | { readonly _tag: "saving"; readonly grant: AtlassianOAuthGrantExchangeResponse; readonly cloudId: string }
  | { readonly _tag: "failed" }

type CallbackTransport = Pick<ConnectionTestTransport, "completeAtlassianOAuthGrant" | "exchangeAtlassianOAuthGrant">

/** Complete a browser OAuth redirect without exposing provider tokens to the browser. */
export const AtlassianOAuthCallbackPage = ({
  transport = browserConnectionTestTransport
}: {
  readonly transport?: CallbackTransport | undefined
} = {}): ReactElement => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { state: sessionState } = useBrowserSession()
  const [state, setState] = useState<CallbackState>({ _tag: "waiting" })
  const exchangeStarted = useRef(false)
  const exchangeRequest = useRef<AbortController | null>(null)
  const saveRequest = useRef<AbortController | null>(null)
  const effectGeneration = useRef(0)

  useEffect(() => {
    const generation = ++effectGeneration.current
    const cleanup = (): void => {
      void Promise.resolve().then(() => {
        if (effectGeneration.current !== generation) return
        exchangeRequest.current?.abort()
        saveRequest.current?.abort()
      })
    }
    if (sessionState._tag !== "authenticated" || exchangeStarted.current) return cleanup
    exchangeStarted.current = true
    if (searchParams.has("error")) {
      setState({ _tag: "failed" })
      return cleanup
    }
    const grantId = Schema.decodeUnknownResult(AtlassianOAuthGrantId)(searchParams.get("state"))
    const code = Schema.decodeUnknownResult(AuthorizationCode)(searchParams.get("code"))
    const exchange = transport.exchangeAtlassianOAuthGrant
    if (Result.isFailure(grantId) || Result.isFailure(code) || exchange === undefined) {
      setState({ _tag: "failed" })
      return cleanup
    }
    const request = new AbortController()
    exchangeRequest.current = request
    setState({ _tag: "exchanging" })
    exchange(grantId.success, code.success, request.signal).then(
      (grant) => {
        if (!request.signal.aborted) setState({ _tag: "selecting", grant, saveFailed: false })
      },
      () => {
        if (!request.signal.aborted) setState({ _tag: "failed" })
      }
    )
    return cleanup
  }, [searchParams, sessionState, transport])

  const complete = (grant: AtlassianOAuthGrantExchangeResponse, cloudId: string): void => {
    const save = transport.completeAtlassianOAuthGrant
    if (save === undefined) {
      setState({ _tag: "failed" })
      return
    }
    const request = new AbortController()
    saveRequest.current?.abort()
    saveRequest.current = request
    setState({ _tag: "saving", grant, cloudId })
    void save(grant.grantId, cloudId, request.signal).then(
      () => navigate("/services?enable=jira", { replace: true }),
      () => {
        if (!request.signal.aborted) setState({ _tag: "selecting", grant, saveFailed: true })
      }
    )
  }

  if (sessionState._tag === "checking") {
    return (
      <section className={styles.page}>
        <StatePanel description="Restoring the browser session that started this sign-in." title="Finishing sign-in" />
      </section>
    )
  }

  if (sessionState._tag !== "authenticated") {
    return (
      <section className={styles.page}>
        <StatePanel
          action={<Button onClick={() => navigate("/services")}>Return to Services</Button>}
          description="Return to the paired browser session that started this sign-in."
          title="Paired session required"
        />
      </section>
    )
  }

  if (state._tag === "failed") {
    return (
      <section className={styles.page}>
        <StatePanel
          action={<Button onClick={() => navigate("/services?enable=jira")}>Try again</Button>}
          description="The grant may have expired, been denied, or already been used. No provider token was saved."
          title="Atlassian sign-in did not finish"
        />
      </section>
    )
  }

  if (state._tag !== "selecting" && state._tag !== "saving") {
    return (
      <section className={styles.page}>
        <StatePanel description="Verifying the single-use grant with Atlassian." title="Finishing sign-in" />
      </section>
    )
  }

  return (
    <section aria-labelledby="atlassian-site-title" className={styles.page}>
      <header className={styles.heading}>
        <Text as="h1" id="atlassian-site-title" variant="page-title">
          Choose your Atlassian site
        </Text>
        <Text tone="secondary" variant="body-large">
          Signed in as {state.grant.accountName}
          {state.grant.accountEmail === null ? "" : ` · ${state.grant.accountEmail}`}. Jira and Confluence will share
          this machine-local profile.
        </Text>
      </header>
      <div className={styles.sites}>
        {state._tag === "selecting" && state.saveFailed ? (
          <Text as="p" tone="secondary" variant="body">
            The shared profile could not be saved to both tools. Fix the local profile store and retry this site.
          </Text>
        ) : null}
        {state.grant.sites.map((site) => (
          <Surface as="article" className={styles.site} key={site.cloudId} padding="default" shape="grouped">
            <div className={styles.identity}>
              <Text as="h2" variant="card-title">
                {site.name}
              </Text>
              <Text tone="secondary" variant="body">
                {site.siteUrl}
              </Text>
            </div>
            <Button
              loading={state._tag === "saving" && state.cloudId === site.cloudId}
              onClick={() => complete(state.grant, site.cloudId)}
              variant="primary"
            >
              Use this site
            </Button>
          </Surface>
        ))}
      </div>
    </section>
  )
}
