import * as Domain from "@knpkv/codecommit-core/Domain.js"
import { Button, StatePanel, Surface, Text } from "@knpkv/rly/primitives"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { type FormEvent, type ReactElement, useEffect, useState } from "react"
import { useNavigate } from "react-router"

import { useBrowserSession } from "../BrowserSession.js"
import { workspaceEntityPath } from "../workspaceEntityPaths.js"
import {
  browserOpenPullRequestTransport,
  type OpenPullRequestResolution,
  type OpenPullRequestTransport
} from "./openPullRequest.js"
import styles from "./OpenPullRequestPage.module.css"

type LookupState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "failed" }
  | OpenPullRequestResolution

export interface OpenPullRequestPageProps {
  readonly transport?: OpenPullRequestTransport
}

/** Open one followed CodeCommit PR from the console URL another person shared. */
export const OpenPullRequestPage = ({
  transport = browserOpenPullRequestTransport
}: OpenPullRequestPageProps = {}): ReactElement => {
  const browserSession = useBrowserSession()
  const navigate = useNavigate()
  const [input, setInput] = useState("")
  const [requestedUrl, setRequestedUrl] = useState("")
  const [lookup, setLookup] = useState<LookupState>({ _tag: "idle" })
  const [lookupAttempt, setLookupAttempt] = useState(0)
  const readableSession =
    browserSession.state._tag === "authenticated" || browserSession.state._tag === "storage-unavailable"
      ? browserSession.state.session
      : null
  const session =
    browserSession.state._tag === "authenticated" &&
    (browserSession.state.session.permission === "workspace-owner" ||
      browserSession.state.session.permission === "workspace-approver")
      ? browserSession.state.session
      : null

  useEffect(() => {
    if (requestedUrl.length === 0) {
      setLookup({ _tag: "idle" })
      return
    }
    if (session === null) return
    const locator = Option.getOrNull(Schema.decodeUnknownOption(Domain.CodeCommitPullRequestUrl)(requestedUrl))
    if (locator === null) {
      setLookup({ _tag: "invalid" })
      return
    }
    const abort = new AbortController()
    setLookup({ _tag: "loading" })
    transport.resolve(locator, abort.signal).then(
      (resolution) => {
        if (abort.signal.aborted) return
        if (resolution._tag === "found") {
          navigate(workspaceEntityPath(session.workspaceId, resolution.candidate.entityId), { replace: true })
          return
        }
        setLookup(resolution)
      },
      (failure) => {
        if (abort.signal.aborted) return
        if (Predicate.isTagged("UnauthorizedApiError")(failure)) {
          browserSession.invalidateSession(session.sessionId)
          return
        }
        setLookup({ _tag: "failed" })
      }
    )
    return () => abort.abort()
  }, [browserSession, lookupAttempt, navigate, requestedUrl, session, transport])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const url = input.trim()
    setRequestedUrl(url)
    setLookupAttempt((current) => current + 1)
  }

  if (readableSession === null) {
    return (
      <StatePanel
        description="Pair this browser with Control Center before resolving a private CodeCommit pull request."
        title="Browser session required"
        tone="caution"
      />
    )
  }

  if (browserSession.state._tag === "storage-unavailable") {
    return (
      <StatePanel
        description="Enable session storage, then pair this browser again before resolving a private CodeCommit pull request."
        title="Browser storage required"
        tone="caution"
      />
    )
  }

  if (session === null) {
    return (
      <StatePanel
        description="Opening a shared CodeCommit PR requires workspace-wide read access."
        title="Workspace reader required"
        tone="caution"
      />
    )
  }

  return (
    <section className={styles.page}>
      <header className={styles.hero}>
        <Text as="h1" variant="page-title">
          Open CodeCommit PR
        </Text>
        <Text tone="secondary" variant="body-large">
          Paste a CodeCommit PR URL from any AWS region. Control Center resolves it inside this workspace; no PR search
          required.
        </Text>
      </header>
      <Surface as="section" className={styles.card} form="grouped" padding="spacious" tone="secondary">
        <form className={styles.form} onSubmit={submit}>
          <label>
            <span>Pull request URL</span>
            <input
              autoComplete="url"
              onChange={(event) => setInput(event.currentTarget.value)}
              placeholder="https://REGION.console.aws.amazon.com/codesuite/codecommit/repositories/…"
              spellCheck={false}
              type="url"
              value={input}
            />
          </label>
          <Button loading={lookup._tag === "loading"} size="principal" type="submit" variant="primary">
            Open pull request
          </Button>
        </form>
      </Surface>
      {lookup._tag === "invalid" ? (
        <StatePanel
          description="Use the full AWS CodeCommit pull-request console URL."
          title="Link not recognized"
          tone="caution"
        />
      ) : lookup._tag === "failed" ? (
        <StatePanel
          description="The workspace index could not be read. Nothing was changed."
          title="Lookup failed"
          tone="caution"
        />
      ) : lookup._tag === "not-found" ? (
        <StatePanel
          description={
            lookup.indexTruncated
              ? "The bounded workspace result was incomplete. Narrow the followed CodeCommit resources, then retry."
              : "This PR is not synchronized into the current workspace yet. Follow its CodeCommit account or repository, then retry."
          }
          title="PR not found"
          tone="neutral"
        />
      ) : lookup._tag === "account-identity-unavailable" ? (
        <StatePanel
          description="Control Center could not map every match to a browser-safe AWS account identity. Refresh Services, then retry."
          title="Account identity unavailable"
          tone="caution"
        />
      ) : lookup._tag === "ambiguous" ? (
        <Surface as="section" className={styles.matches} form="grouped" padding="spacious" tone="secondary">
          <Text as="h2" variant="section-title">
            Choose the connected account
          </Text>
          <Text tone="secondary" variant="body">
            AWS Console links omit the account. These followed connections contain the same repository and PR number.
          </Text>
          {lookup.candidates.map((candidate) => (
            <Button
              key={candidate.entityId}
              onClick={() => navigate(workspaceEntityPath(session.workspaceId, candidate.entityId))}
              variant="secondary"
            >
              {`${candidate.accountLabel} · ${candidate.title}`}
            </Button>
          ))}
        </Surface>
      ) : null}
    </section>
  )
}
