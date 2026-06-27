# Jira Markdown

Jira Markdown is the context for representing Jira work items as local Markdown documents and reconciling changes between Jira and those documents.

## Language

**Command Surface**:
The user-facing CLI contract of a package, including command names, subcommands, arguments, flags, output modes, prompts, and mutation safety conventions.
_Avoid_: API, SDK, internal command implementation

**Product Binary**:
The primary executable name for a product-specific Command Surface, such as `jira`, `confluence`, `codecommit`, or `jcf`.
_Avoid_: Umbrella command, package command

**Command Convention**:
A shared CLI behavior or naming rule that should feel the same across product-specific Command Surfaces without requiring every product to use the same resource nouns.
_Avoid_: Universal command grammar, one-size-fits-all CLI

**JSON Output Contract**:
The machine-readable CLI output rule where `--json` writes exactly one JSON value to stdout while progress, warnings, and human hints go to stderr.
_Avoid_: Parseable text, quiet mode

**Dry Run**:
A preview mode for a command that can accurately describe the remote or local changes it would make without applying them.
_Avoid_: No-op mode, safety flag

**Documentation Site**:
The published documentation experience for the package collection, initially focused on Canonical Commands, Command Conventions, agent skills, and migration guidance.
_Avoid_: README collection, SDK reference site

**Product Guide**:
A Documentation Site section organized around one Product Binary and its Canonical Commands.
_Avoid_: Task guide, package README

**Command Reference**:
A Documentation Site page or section that records the exact syntax, arguments, flags, output modes, and mutability class of a Canonical Command.
_Avoid_: Guide, tutorial, README example

**Canonical Command**:
The preferred command spelling that documentation, help text, and agent skills should teach after a Command Surface has been simplified.
_Avoid_: Alias, legacy command

**Resource Command**:
A Canonical Command grouped under the domain object it operates on, such as an issue, version, page, or pull request.
_Avoid_: Top-level action command, verb-first command

**Read-Only Command**:
A command that observes remote or local state without changing it and must be safe for an agent to run without confirmation.
_Avoid_: Harmless command, safe command

**Local Write Command**:
A command that changes local files, local configuration, local caches, or local sync metadata without mutating a remote service.
_Avoid_: Offline command, safe write

**Remote Write Command**:
A command that mutates Jira, Confluence, CodeCommit, Clockify, or another external service and therefore requires explicit intent before an agent runs it.
_Avoid_: Dangerous command, update command

**Explicit Intent**:
The user-provided command arguments or interactive choices that identify the exact remote mutation a Remote Write Command should perform.
_Avoid_: Confirmation prompt, safety question

**Jira Markdown Sync**:
A two-way workflow where Jira issues and local Markdown documents can both be sources of change that are reconciled into a shared issue state.
_Avoid_: Jira Markdown Export, Jira report, snapshot export

**Sync Workflow Command**:
A Canonical Command that reconciles local workspace state with a remote service, distinct from one-off read commands and ordinary local file operations.
_Avoid_: Search export, markdown report command, generic sync command

**Confluence Workspace**:
A local Markdown mirror of a Confluence page tree together with the metadata needed to reconcile it with Confluence.
_Avoid_: Export folder, page dump

**Page Command**:
A Resource Command that operates on Confluence pages.
_Avoid_: Document command, Confluence file command

**Issue Command**:
A Resource Command that operates on Jira issues without implying membership in Jira Markdown Sync.
_Avoid_: Ticket command, Jira export command

**Version Command**:
A Resource Command that operates on Jira project versions and their release metadata.
_Avoid_: Release command, fix version command

**PR Command**:
A Resource Command that operates on CodeCommit pull requests.
_Avoid_: Pull request command, CodeCommit review command

**Timer Command**:
A Resource Command that operates on Jira-backed Clockify timer state.
_Avoid_: Time command, worklog command

**Jira Custom Field**:
A Jira issue field defined by a Jira site or project outside Jira's built-in issue fields, identified operationally by a site-specific field id and often shown to users by a display name.
_Avoid_: Extra field, metadata field

**Requested Custom Field**:
A Jira Custom Field that the user has explicitly included in Jira Markdown Sync and expects to participate in write-back after validation.
_Avoid_: Optional field, discovered field

**Sync Validation**:
The pre-write check that determines whether Markdown changes can be safely applied to Jira before Jira Markdown Sync mutates remote issue state.
_Avoid_: Best-effort write, dry run

**Valid Candidate Value**:
A possible field value that has passed Sync Validation and may be used as a planned change or Conflict Winner.
_Avoid_: Forced value, unchecked value

**Explicit Clear**:
A deliberate `null` value in a reconciled field that means Jira Markdown Sync should clear the corresponding Jira value when Jira allows it.
_Avoid_: Missing field, empty by accident

**Missing Reconciled Field**:
A field required by the Jira Markdown Document structure or Field Sync Contract but absent from the document, causing Sync Validation to fail.
_Avoid_: Unchanged field, implicit clear

**Permission Gap**:
A validation failure where the authenticated Jira user can read a Tracked Issue but cannot apply one or more planned writes.
_Avoid_: Auth error, partial access

**Read-Only Edit**:
A local change to a Read-Only Field that blocks Jira Markdown Sync until the user removes or explicitly restores it.
_Avoid_: Harmless edit, display change

**Field Sync Contract**:
The user-declared set of Jira Custom Fields that Jira Markdown Sync may reconcile, including the expected shape needed to validate local Markdown before write-back.
_Avoid_: Field list, custom field options

**Workspace Config**:
The local workspace-level configuration that contains the Field Sync Contract and other sync policy separate from Issue Documents and the Sync Manifest.
_Avoid_: Issue front matter, manifest entries

**Field Shape**:
The expected value kind for a Requested Custom Field, declared by the user and verified against Jira metadata before write-back.
_Avoid_: Inferred type, raw Jira schema

**Supported Field Shape**:
A Field Shape that Jira Markdown Sync can validate and write, initially text, multiline text, number, boolean, date, single select, multi select, user picker, or cascading select.
_Avoid_: Any Jira field type, raw custom field

**Date Field**:
A Supported Field Shape represented as a calendar date without time or timezone.
_Avoid_: Datetime field, timestamp

**Unsupported Field Shape**:
A Jira Custom Field shape that cannot satisfy the Field Sync Contract and therefore blocks sync when requested.
_Avoid_: Read-only requested field, best-effort field

**Document Migration**:
An explicit update to existing Issue Documents and Sync Baselines required after the Field Sync Contract or document structure changes.
_Avoid_: Ordinary sync, automatic rewrite

**Local Migration**:
A Document Migration that changes only local workspace state and does not mutate Jira.
_Avoid_: Sync apply, remote migration

**Sync Conflict**:
A field-level disagreement where both Jira and the local Markdown document changed the same issue field since the previous successful sync.
_Avoid_: Merge error, overwrite warning

**Sync Baseline**:
The last issue state that Jira Markdown Sync successfully reconciled between Jira and the local Markdown document, used to identify later changes on either side.
_Avoid_: Cache, snapshot, export state

**Baseline Identity Data**:
The stable Jira identifiers stored in a Sync Baseline only when needed to validate, compare, or write reconciled fields correctly.
_Avoid_: Display metadata, exported PII

**Issue Key**:
The human-readable Jira issue identifier displayed in project workflows, such as `PROJ-123`.
_Avoid_: Ticket number, filename id

**Issue Id**:
The durable Jira issue identity that remains the same even when the visible Issue Key changes.
_Avoid_: Issue key, ticket key

**Jira Markdown Document**:
A local Markdown document with a defined structure that represents one Jira issue and separates reconciled issue fields from ordinary human notes.
_Avoid_: Exported ticket, arbitrary issue note

**Issue Document**:
A Jira Markdown Document that represents exactly one Tracked Issue.
_Avoid_: Combined export, issue collection

**Convention Filename**:
An Issue Document filename derived from the current Issue Key and therefore eligible for automatic rename when Jira changes the Issue Key.
_Avoid_: Custom filename, durable identity

**Document Path**:
The Sync Manifest's recorded location of an Issue Document within the visible workspace files.
_Avoid_: Scanned file, issue identity

**Path Repair**:
An explicit correction of the Sync Manifest after an Issue Document has moved outside the recorded Document Path.
_Avoid_: Automatic scan, normal sync

**Issue Report**:
A read-only Markdown document that presents multiple Jira issues for human review but does not participate in Jira Markdown Sync.
_Avoid_: Sync document, editable issue collection

**Sync Manifest**:
The authoritative local record of which Issue Documents belong to a Jira Markdown Sync workspace.
_Avoid_: Directory scan, file list

**Sync Workspace**:
A local collection of Issue Documents, Sync Baselines, and sync configuration for one Jira site.
_Avoid_: Export folder, multi-site workspace

**Workspace Metadata**:
The hidden local state of a Sync Workspace, including config, manifest, baselines, and local history, kept separate from visible Issue Documents.
_Avoid_: Issue document, local note

**Workspace Initialization**:
The creation of an empty Sync Workspace before any Issue Import occurs.
_Avoid_: Issue import, first sync

**Shareable Workspace Data**:
The parts of a Sync Workspace that may be reviewed or committed intentionally, excluding authentication secrets and other local-only credentials.
_Avoid_: Public export, secret store

**Local Credential**:
Authentication material used to access Jira from one user's machine and never part of Shareable Workspace Data.
_Avoid_: Workspace config, sync metadata

**Issue Field Applicability**:
Whether a Requested Custom Field can be read and written for a specific Tracked Issue based on that issue's Jira project and issue type.
_Avoid_: Global field availability, project setting

**Issue Import**:
The act of adding existing Jira issues to a Sync Workspace so they become Tracked Issues.
_Avoid_: Issue creation, report generation

**Clean Import**:
An Issue Import where the created Issue Document and Sync Baseline both represent the same current Jira state.
_Avoid_: First sync, partial document

**Import Failure**:
An Issue Import result where a Jira issue is not added to the Sync Workspace because it could not produce a valid Clean Import.
_Avoid_: Partial import, broken document

**Import Source**:
A one-time selector, such as JQL or explicit Issue Keys, used to choose issues for Issue Import without becoming ongoing workspace membership.
_Avoid_: Live subscription, saved filter

**Field Change**:
A difference in a reconciled issue field compared with the Sync Baseline, independent of whether Jira's overall issue timestamp changed.
_Avoid_: Issue update, timestamp change

**Remote-Only Change**:
A Field Change made in Jira while the corresponding local value still matches the Sync Baseline.
_Avoid_: Conflict, forced pull

**Local-Only Change**:
A Field Change made in a Jira Markdown Document while the corresponding Jira value still matches the Sync Baseline.
_Avoid_: Conflict, local note

**Read-Only Field**:
A Jira issue field shown in a Jira Markdown Document but not accepted as a local change during Jira Markdown Sync.
_Avoid_: Ignored field, unsupported field

**Writable Label**:
A Jira label represented as a simple reconciled value that may be changed from a Jira Markdown Document.
_Avoid_: Component, fix version

**Writable Summary**:
The Jira issue summary represented as a reconciled value that may be changed from a Jira Markdown Document.
_Avoid_: Issue key, document filename

**Append-Only Comment**:
A comment authored in a Jira Markdown Document that may create a new Jira comment during sync but does not edit or delete existing Jira comments.
_Avoid_: Editable comment, comment sync

**Comment Draft**:
An Append-Only Comment written in the same supported Markdown subset as the Description Section and awaiting creation in Jira.
_Avoid_: Synced comment edit, plain text note

**Draft Id**:
A local identity for a Comment Draft used to track retries until Jira creates an Accepted Comment.
_Avoid_: Jira comment id, comment number

**Accepted Comment**:
A former Comment Draft that Jira has created and returned as a read-only Jira comment in the Issue Document.
_Avoid_: Draft comment, editable comment

**Attachment Reference**:
A read-only representation of a Jira attachment in a Jira Markdown Document.
_Avoid_: Synced attachment, local attachment

**Tracked Issue**:
An existing Jira issue that has a Jira Markdown Document and Sync Baseline under Jira Markdown Sync.
_Avoid_: New draft issue, imported issue

**Untracked Issue**:
A Jira issue that no longer has an active local Jira Markdown Document under Jira Markdown Sync, while the Jira issue itself remains unchanged.
_Avoid_: Deleted issue, removed ticket

**Unavailable Issue**:
A Tracked Issue whose Jira state cannot be read during sync because it was deleted, moved out of access, or blocked by permissions.
_Avoid_: Deleted issue, missing file

**Local Note**:
Content inside a Jira Markdown Document that belongs only to the local document and is never reconciled back to Jira.
_Avoid_: Jira comment, description note

**Sync Plan**:
The preview of validated changes that Jira Markdown Sync intends to apply, including detected conflicts and any blocking validation failures.
_Avoid_: Dry run output, diff report

**Sync Apply**:
The sync phase that recomputes a valid Sync Plan and applies accepted writes to Jira and local Issue Documents.
_Avoid_: Push, upload

**Accepted Change**:
A planned change that Jira has confirmed during sync and that can therefore advance the Sync Baseline even if another planned change fails later.
_Avoid_: Attempted change, queued update

**Unconfirmed Write**:
A write attempt whose Jira result is unknown because sync did not receive reliable confirmation.
_Avoid_: Accepted change, failed change

**Idempotent Rerun**:
A later sync run that continues from the current Jira state, Issue Document, and Sync Baseline without reapplying Accepted Changes.
_Avoid_: Replay, duplicate apply

**Sync History**:
A local record of Applied Changes made by Jira Markdown Sync for audit and troubleshooting.
_Avoid_: Jira history, debug log

**Local Sync History**:
Sync History kept outside Shareable Workspace Data by default because it may contain issue content, field values, user identities, and timestamps.
_Avoid_: Team audit log, committed history

**Interactive Conflict Resolution**:
A user-guided choice made during sync to resolve a Sync Conflict by selecting which side's field value should win.
_Avoid_: Automatic merge, silent overwrite

**Conflict Winner**:
The field value selected during Interactive Conflict Resolution to become the shared value for Jira, the Issue Document, and the Sync Baseline.
_Avoid_: Preferred side, merge result

**Non-Interactive Sync**:
A sync run where user prompts are unavailable or disabled, so unresolved Sync Conflicts must stop the run before write-back.
_Avoid_: Batch overwrite, unattended prompt

**Custom Field Map**:
The section of a Jira Markdown Document that contains Requested Custom Field values, keyed by the configured Jira Custom Field display name.
_Avoid_: Extra front matter, custom metadata

**Complete Field Value**:
The full desired value for a writable field as represented in a Jira Markdown Document, rather than an incremental add or remove instruction.
_Avoid_: Patch, delta

**Canonical Field Order**:
The stable ordering Jira Markdown Sync applies to list-like field values when the field's business meaning is unordered.
_Avoid_: User ordering, Jira return order

**Field Id**:
The site-specific Jira identifier for a Jira Custom Field, used when a display name is ambiguous or not stable enough for validation.
_Avoid_: Field name, custom field label

**Field Display Name**:
The human-readable Jira Custom Field name used as the default identifier for a Requested Custom Field when it resolves unambiguously in Jira.
_Avoid_: Field id, YAML key only

**User Identity**:
The stable Jira account identity used to validate and write user-picker values, distinct from a person's display name.
_Avoid_: User name, assignee label

**User Field Value**:
A user-picker custom field value represented with both a readable display name and the stable User Identity needed for write-back.
_Avoid_: Display name only, email identity

**Option Field Value**:
A select custom field value represented with both a readable option value and the stable Jira option id when Jira provides one.
_Avoid_: Option label only, raw option id

**Cascading Field Value**:
A cascading select value represented as structured parent and child Option Field Values.
_Avoid_: Flattened option path, parent-child string

**Reconciled Section**:
A section of a Jira Markdown Document that Jira Markdown Sync parses, validates, applies to Jira when changed, and may rewrite into canonical formatting after successful sync.
_Avoid_: User note, generated block

**Description Section**:
The Reconciled Section that represents the Jira issue description as editable Markdown.
_Avoid_: Rendered description, HTML body

**Multiline Field Section**:
A Reconciled Section used for a multiline text custom field so long content can be edited as Markdown body content instead of YAML front matter.
_Avoid_: YAML block scalar, local note

**Unsupported Jira Content**:
Jira issue content that Jira Markdown Sync cannot represent and preserve in a Jira Markdown Document without losing meaning or structure.
_Avoid_: Formatting glitch, harmless conversion
