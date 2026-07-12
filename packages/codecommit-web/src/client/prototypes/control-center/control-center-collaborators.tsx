import avatarMaya from "./assets/people/avatar-00.webp"
import avatarAlex from "./assets/people/avatar-01.webp"
import avatarPriya from "./assets/people/avatar-02.webp"
import avatarJordan from "./assets/people/avatar-03.webp"
import avatarLeo from "./assets/people/avatar-04.webp"
import avatarSam from "./assets/people/avatar-05.webp"
import type { EntityRecord } from "./control-center-foundation.js"

export interface Collaborator {
  readonly avatar: string
  readonly name: string
  readonly role: string
}

export const releaseCollaborators: Readonly<Record<string, ReadonlyArray<Collaborator>>> = {
  "payments-api": [
    { avatar: avatarAlex, name: "Alex Kim", role: "Release owner" },
    { avatar: avatarMaya, name: "Maya Chen", role: "Production approver" }
  ],
  "checkout-web": [
    { avatar: avatarPriya, name: "Priya Shah", role: "Release owner" },
    { avatar: avatarMaya, name: "Maya Chen", role: "Reviewer" }
  ],
  "identity-api": [
    { avatar: avatarSam, name: "Sam Rivera", role: "Release owner" },
    { avatar: avatarJordan, name: "Jordan Lee", role: "Approver" }
  ],
  "ledger-worker": [
    { avatar: avatarJordan, name: "Jordan Lee", role: "Release owner" },
    { avatar: avatarAlex, name: "Alex Kim", role: "Reviewer" }
  ],
  notifications: [
    { avatar: avatarMaya, name: "Maya Chen", role: "Release owner" },
    { avatar: avatarLeo, name: "Leo Martins", role: "Reviewer" }
  ],
  "risk-engine": [
    { avatar: avatarPriya, name: "Priya Shah", role: "Release owner" },
    { avatar: avatarJordan, name: "Jordan Lee", role: "Risk approver" }
  ]
}

export const wipCollaborators: ReadonlyArray<Collaborator> = [
  { avatar: avatarAlex, name: "Alex Kim", role: "Change owner" },
  { avatar: avatarMaya, name: "Maya Chen", role: "Reviewer" }
]

export function CollaboratorStack({ people }: { readonly people: ReadonlyArray<Collaborator> }) {
  return (
    <div className="cc-collaborators" aria-label={people.map(({ name, role }) => `${name}, ${role}`).join("; ")}>
      <div className="cc-collaborator-faces" aria-hidden="true">
        {people.map(({ avatar, name }) => (
          <img alt="" key={name} src={avatar} />
        ))}
      </div>
      <div className="cc-collaborator-names">
        {people.map(({ name, role }) => (
          <small key={name}>
            <b>{name}</b> · {role}
          </small>
        ))}
      </div>
    </div>
  )
}

const entityFact = (entity: EntityRecord, label: string) => entity.facts.find(([candidate]) => candidate === label)?.[1]

const avatarByName: Readonly<Record<string, string>> = {
  "Alex K.": avatarAlex,
  "Alex Kim": avatarAlex,
  "Jordan Lee": avatarJordan,
  "Leo Martins": avatarLeo,
  "Maya Chen": avatarMaya,
  "Priya Shah": avatarPriya,
  "Sam Rivera": avatarSam
}

const person = (sourceName: string, role: string): Collaborator => {
  const name = sourceName === "Alex K." ? "Alex Kim" : sourceName === "Nina Patel" ? "Priya Shah" : sourceName
  return { avatar: avatarByName[name] ?? avatarLeo, name, role }
}

function entityCollaborators(entity: EntityRecord): ReadonlyArray<Collaborator> {
  const owner = entityFact(entity, "OWNER") ?? "Alex Kim"
  const author = entityFact(entity, "AUTHOR") ?? "Alex Kim"
  if (entity.service === "code") {
    return [
      person(author, "Author"),
      person(author === "Maya Chen" ? "Alex Kim" : "Maya Chen", "PR reviewer"),
      person("Priya Shah", "Merge approver")
    ]
  }
  if (entity.service === "jira") {
    return [
      person(owner, "Issue owner"),
      person(owner === "Maya Chen" ? "Alex Kim" : "Maya Chen", "Ticket reviewer"),
      person("Priya Shah", "Release approver")
    ]
  }
  if (entity.service === "confluence") {
    return [
      person("Priya Shah", "Page owner"),
      person("Alex Kim", "Contributor"),
      person("Maya Chen", "Runbook approver")
    ]
  }
  if (entity.service === "pipeline") {
    return [
      person("Alex Kim", "Release owner"),
      person("Maya Chen", "Deploy approver"),
      person("Sam Rivera", "On-call operator")
    ]
  }
  return [
    person("Maya Chen", "Contributor"),
    person("Alex Kim", "Contributor"),
    person("Priya Shah", "Workspace approver")
  ]
}

export function EntityCollaborators({ entity }: { readonly entity: EntityRecord }) {
  const headingId = `collaborators-${entity.id.replaceAll(":", "-")}`
  return (
    <section className="cc-entity-collaborators" aria-labelledby={headingId}>
      <h2 id={headingId}>People</h2>
      <CollaboratorStack people={entityCollaborators(entity)} />
    </section>
  )
}
