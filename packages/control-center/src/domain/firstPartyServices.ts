import * as Schema from "effect/Schema"

import { ProviderId } from "./sourceRevision.js"

/** Safe provider identity rendered before a browser has access to workspace connections. */
export const FirstPartyServiceIdentity = Schema.Struct({
  providerId: ProviderId,
  displayName: Schema.String,
  description: Schema.String
}).annotate({ identifier: "FirstPartyServiceIdentity" })

/** Decoded safe first-party provider identity. */
export type FirstPartyServiceIdentity = typeof FirstPartyServiceIdentity.Type

/** Stable provider lookup shared by public previews and the server-owned setup catalog. */
export const firstPartyServiceIdentityByProvider = {
  codecommit: {
    providerId: "codecommit",
    displayName: "CodeCommit",
    description: "Read pull requests from one AWS CodeCommit repository."
  },
  codepipeline: {
    providerId: "codepipeline",
    displayName: "CodePipeline",
    description: "Read pipeline and execution state from AWS CodePipeline."
  },
  jira: {
    providerId: "jira",
    displayName: "Jira",
    description: "Read delivery issues from Jira Cloud."
  },
  confluence: {
    providerId: "confluence",
    displayName: "Confluence",
    description: "Read release documentation from Confluence Cloud."
  },
  clockify: {
    providerId: "clockify",
    displayName: "Clockify",
    description: "Read bounded time-entry evidence from Clockify."
  }
} satisfies Readonly<Record<typeof ProviderId.Type, FirstPartyServiceIdentity>>

/** Stable first-party services available to every Control Center installation. */
export const firstPartyServiceIdentities = [
  firstPartyServiceIdentityByProvider.codecommit,
  firstPartyServiceIdentityByProvider.codepipeline,
  firstPartyServiceIdentityByProvider.jira,
  firstPartyServiceIdentityByProvider.confluence,
  firstPartyServiceIdentityByProvider.clockify
] satisfies ReadonlyArray<FirstPartyServiceIdentity>
