# Control Center

Control Center connects work, code, delivery, knowledge, time, people, and agents without collapsing the identities of the external systems it integrates, and supports governed collaboration between people and agents.

## Language

**Workspace**:
The collaboration boundary in which people connect provider accounts, follow resources, and inspect delivery state.
_Avoid_: Organization, tenant, project

**Provider Account**:
One external account or site authorized for a Workspace, such as an AWS account or Atlassian site. A Provider Account may own many Followed Resources.
_Avoid_: Service connection, repository connection, plugin

**Local Credential Profile**:
A machine-local selector used to authenticate a Provider Account without becoming part of shareable Workspace data.
_Avoid_: Provider account, connection, credentials record

**Followed Resource**:
A provider-owned resource selected for observation within a Provider Account, such as a repository, pipeline, Jira project, or Confluence space.
_Avoid_: Account, service, plugin

**Plugin Connection**:
The executable adapter binding that synchronizes one Followed Resource into a Workspace. Multiple Plugin Connections may share one Provider Account.
_Avoid_: Provider account, credential profile

**Delivery Relationship**:
An evidence-backed association between normalized work, code, release, deployment, knowledge, or time entities.
_Avoid_: Name match, UI link

**Release Workset**:
The Jira items selected for one release together with their pull-request and pipeline dimensions.
_Avoid_: Ticket list, sprint board

**Local Operator**:
The single person running and using the local Control Center instance. Connected-service collaborators remain visible as Jira, CodeCommit, or Confluence identities but are not Control Center users. Actor identifiers are retained for audit and future evolution, not real-time multi-user collaboration.
_Avoid_: Workspace member, tenant user, collaborator

**Exploratory Review Run**:
A read-only, immutable child of a Review Thread that assesses one exact pull-request revision through a fresh Review Sandbox and returns Review Suggestions without changing an external service. It starts only from an explicit Full review, re-review, single-suggestion revalidation, or targeted thread request. A new pull-request head makes older suggestions stale but does not start a run automatically. It has no subjective overall verdict; Control Center derives the run's Review State from its structured result.
_Avoid_: Automated review, static-analysis run, autonomous reviewer

**Review Thread**:
The durable, Control Center-owned conversation between the Local Operator and review agents for one pull request. It preserves messages, Review Suggestions, Review Notes, resolutions, and immutable run history across changes to the pull-request head without relying on a provider's CLI session.
_Avoid_: Codex thread, chat session, review run

**Review Context Snapshot**:
The bounded, structured history supplied to one Exploratory Review Run: current pull request and revision, summaries of active, stale, dismissed, and resolved suggestions, relevant recent operator messages, and prior limitations. Full history remains available through an explicit lookup tool; targeted revalidation includes the selected suggestion's complete revision and evidence history.
_Avoid_: Full transcript, prompt history, provider session

**Review Agent Profile**:
The explicit provider configuration used by an Exploratory Review Run, including provider, model, CLI version, and effective options. The local instance supplies the default profile and the launch popup may override it for one run; providers never fall back silently.
_Avoid_: Model, agent name, implicit fallback

**Agent Tool Loop**:
The provider-neutral execution module in `@knpkv/ai-runtime` that uses an Effect AI LanguageModel to select typed tools, executes those tools through the Review Sandbox module, feeds bounded results back to the model, and returns schema-validated output. Provider CLIs receive tool results but never direct host or Docker access.
_Avoid_: Native CLI tools, shell agent, prompt loop

**Review Instruction Set**:
The effective instructions for an Exploratory Review Run. Local review policy has highest priority, and repository instructions are loaded only from the trusted base revision. Instruction-file changes in the pull request are treated as untrusted content under review, never as commands for the current run. Within those constraints, the agent chooses the appropriate lint, typecheck, test, build, and reproduction commands for the change and remaining Review Budget, while recording untested areas.
_Avoid_: Prompt, head instructions, repository policy

**Review Runner**:
The trusted, locally selected container image used to create Review Sandboxes, pinned by immutable digest. A pull request cannot change the runner that evaluates it; the Local Operator must separately accept a proposed image before it affects later runs.
_Avoid_: Repository Dockerfile, latest image, agent image

**Review Checkout Broker**:
The trusted host-side component that reuses the connected CodeCommit profile to fetch and verify the exact base and head commits, removes authenticated remotes and credential configuration, copies the resulting checkout into an isolated writable Docker volume, and deletes host staging data after handoff.
_Avoid_: Git clone in the sandbox, repository mount, AWS credentials

**Review Sandbox**:
An ephemeral, unprivileged Docker environment containing a writable checkout of the exact reviewed revision. Within that boundary the agent may autonomously inspect files, run commands and tests, build, and create temporary changes without per-command approval. The host checkout, Docker socket, and host credentials are never mounted writable or exposed, and sandbox changes are never propagated automatically. Outbound network access is disabled unless the run receives an explicit Sandbox Network Grant. Activity is observable and the run remains cancellable.
_Avoid_: Workspace, host checkout, development container

**Review Budget**:
The visible per-run execution allowance for an Exploratory Review Run. A Full review receives 20 minutes by default, may finish early, and may receive one explicit extension. Exhausting the budget produces an Unable to Conclude state with partial suggestions, evidence, and unreviewed areas rather than discarding the run. Control Center imposes no global concurrency limit on independent runs.
_Avoid_: Hidden timeout, token limit, deadline

**Sandbox Network Grant**:
An explicit, auditable allowlist of unauthenticated outbound endpoints made available to one Exploratory Review Run for integration testing. The AI orchestrator does not require this grant because it operates outside the Review Sandbox.
_Avoid_: Internet access, host network, network mode

**Review State**:
A status derived by Control Center rather than asserted by the agent: Changes Required when P1 or P2 suggestions remain open, Non-blocking Suggestions when only P3 or P4 remain, No Issues Found only when a completed run returns no suggestions, or Unable to Conclude when exploration is incomplete. Validated suggestions from an incomplete run remain independently publishable while the UI retains a persistent incomplete-review warning.
_Avoid_: Agent verdict, approval, thumbs-up

**Review Run Status**:
The execution lifecycle of an Exploratory Review Run, separate from its derived Review State: preparing, running, completed, cancelled, interrupted, failed, or timed out. On startup, Control Center reattaches to a labeled live Review Sandbox; if no live execution remains, the run becomes interrupted and may be restarted only as a new immutable run.
_Avoid_: Review state, agent verdict, suggestion status

**Review Suggestion**:
An editable, structured observation about a validated defect introduced or exposed by the reviewed pull request and retained as a draft until a person explicitly publishes it. Every suggestion contains a title, Suggestion Anchor, problem, impact, reproducible Review Evidence, recommendation, Suggestion Severity, and Confidence with reason. It may also contain a Suggested Replacement and Prevention Proposal.
_Avoid_: Finding, comment, agent verdict

**Review Note**:
A visible, non-publishable observation about relevant surrounding code that the reviewed pull request did not introduce, or a suspected pull-request defect that still needs verification. It is shown separately from Review Suggestions and offers no action to post it to CodeCommit.
_Avoid_: Suggestion, unrelated finding, author responsibility

**Review Evidence**:
The concrete code path, command result, test failure, or other reproducible observation that validates a Review Suggestion.
_Avoid_: Agent reasoning, intuition, confidence

**Confidence**:
The visible strength of the evidence supporting a Review Suggestion or Review Note, accompanied by a short reason. High means directly reproduced or proven by deterministic analysis; Medium means strongly supported by code-path evidence without end-to-end execution; Low means plausible but unverified and therefore eligible only for a Review Note. It expresses certainty that the observation is correct, not the severity of its impact.
_Avoid_: Severity, priority, approval

**Suggestion Severity**:
The impact of a validated Review Suggestion: P1 Blocker is unsafe to merge, P2 Major should be fixed before merge, P3 Minor is a valid defect with limited impact, and P4 Improvement is useful but non-blocking. Severity is independent of Confidence.
_Avoid_: Confidence, certainty, agent score

**Suggestion Anchor**:
The scope a Review Suggestion addresses: a specific line, a file as a whole, or the pull-request changes as a whole. When published, a line anchor maps to that diff line, a file anchor maps to the file's first changed line or falls back to line 1, and a whole-change anchor maps to a general pull-request comment.
_Avoid_: Comment location, line number

**Related Location**:
An additional line or file affected by the same root cause as a Review Suggestion's primary Suggestion Anchor. Related locations are navigable from one deduplicated suggestion rather than emitted as repetitive suggestions.
_Avoid_: Duplicate finding, secondary suggestion, comment anchor

**Suggested Replacement**:
An optional unified diff against the exact reviewed head, with a short explanation, attached to a Review Suggestion. It is rendered as a before/after preview and remains inert draft content: accepting it may publish the fenced diff as review-comment content but never changes the branch.
_Avoid_: Autofix, applied patch, generated commit

**Prevention Proposal**:
An optional, non-executing recommendation attached to a Review Suggestion for preventing a recurring, high-impact, mechanically enforceable defect class through ast-grep, ESLint, a type check, a test, or repository agent instructions.
_Avoid_: Automatic guardrail, required rule, repository mutation

**Suggestion Revision**:
An immutable version in a Review Suggestion's edit history. An agent may create a new revision of a draft suggestion in response to a human request, but cannot erase prior revisions or publish the result. If the edit changes the technical claim, its existing Review Evidence is no longer sufficient and the suggestion requires revalidation.
_Avoid_: Comment edit, overwrite, agent fix

**Suggestion Revalidation**:
A new agent assessment of a Review Suggestion against its immutable reviewed revision after the suggestion has been edited or challenged.
_Avoid_: Retry, approval, spellcheck

**Suggestion Reconciliation**:
The ID-based comparison performed by a re-review against prior suggestions. The agent reports distinct root causes as new with new IDs; for each prior stable suggestion ID, it reports still-present with updated anchor and evidence, resolved with validation evidence, or reopened with materially new evidence. Control Center validates every referenced ID and preserves prior revisions.
_Avoid_: Line matching, replacement, report diff

**Stale Review Suggestion**:
A Review Suggestion whose reviewed revision is no longer the pull request's current head. It remains visible in history but cannot be published until a re-review evaluates it against the new immutable head.
_Avoid_: Old comment, invalid finding, deleted suggestion

**Resolved Review Suggestion**:
A historical Review Suggestion that a later re-review or person has determined no longer requires action. A re-review agent may resolve it locally without human confirmation, but its resolution remains visible alongside the rationale, evidence, and exact revision that justified it. If the suggestion was already published, posting a resolution reply to CodeCommit remains a separate, previewed human action.
_Avoid_: Deleted suggestion, hidden finding, closed comment

**Dismissed Review Suggestion**:
A Review Suggestion a person has intentionally declined without publishing, with a required reason of false positive, not applicable, accepted risk, duplicate, or other. It remains visible and informs later runs so the same concern is not repeated without new evidence. A later re-review may reopen it only when it records materially new evidence, displayed beside the original dismissal reason.
_Avoid_: Deleted suggestion, resolved suggestion, ignored finding

**Published Review Comment**:
A versioned snapshot of a Review Suggestion created as a CodeCommit review comment only after a person explicitly accepts its content and publication. Line and file suggestions are published inline according to their Suggestion Anchor; whole-change suggestions are published as general pull-request comments. A compact visible footer identifies the proposing Review Agent Profile, exact reviewed head, and publishing person while CodeCommit retains the person's AWS identity as author. Later draft edits never synchronize automatically; updating the remote comment requires a new explicit publication preview.
_Avoid_: Accepted suggestion, agent comment, automatic comment
