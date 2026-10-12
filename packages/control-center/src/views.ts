/** Controlled browser views. Hosts supply data, callbacks, routing, theme and portal roots. */
export { BrowserSessionStatusView, type BrowserSessionStatusViewProps } from "./client/BrowserSessionStatusView.js"
export type { BrowserSessionStatusPresentation } from "./client/BrowserSessionStatusView.js"
export {
  ReviewSuggestionOverview,
  type ReviewSuggestionOverviewProps
} from "./client/entities/ReviewSuggestionOverview.js"
export {
  ReviewNotes,
  type ReviewNotesProps,
  ReviewSuggestionCard,
  type ReviewSuggestionCardProps
} from "./client/entities/ReviewSuggestionPresentation.js"
export {
  ReviewSuggestionPublicationSurface,
  type ReviewSuggestionPublicationSurfaceProps
} from "./client/entities/ReviewSuggestionPublicationSurface.js"
export type {
  PullRequestReviewPublicationState,
  ReviewSuggestionPublicationTarget
} from "./client/entities/ReviewSuggestionPublicationSurface.js"
export {
  ReviewSuggestionRevisionDialog,
  type ReviewSuggestionRevisionDialogProps
} from "./client/entities/ReviewSuggestionRevisionDialog.js"
export {
  ReviewSuggestionRevisionHistory,
  type ReviewSuggestionRevisionHistoryProps
} from "./client/entities/ReviewSuggestionRevisionHistory.js"
export {
  WorkspaceClockifyTimeEntryDetails,
  type WorkspaceClockifyTimeEntryDetailsProps
} from "./client/entities/WorkspaceClockifyTimeEntryDetails.js"
export type { ClockifyActionSubmissionState } from "./client/entities/WorkspaceClockifyTimeEntryDetails.js"
export { WorkspaceIssueDetails, type WorkspaceIssueDetailsProps } from "./client/entities/WorkspaceIssueDetails.js"
export {
  WorkspacePipelineExecutionDetails,
  type WorkspacePipelineExecutionDetailsProps
} from "./client/entities/WorkspacePipelineExecutionDetails.js"
export { WorkspaceRichText, type WorkspaceRichTextProps } from "./client/entities/WorkspaceRichText.js"
export { PortfolioOverviewView, type PortfolioOverviewViewProps } from "./client/portfolio/PortfolioOverviewView.js"
export type { PortfolioOverviewState } from "./client/portfolio/PortfolioOverviewView.js"
export type { PortfolioPresentation, PortfolioReleasePresentation } from "./client/portfolio/presentPortfolio.js"
export {
  RelationshipRepairPanelView,
  type RelationshipRepairPanelViewProps
} from "./client/releases/RelationshipRepairPanelView.js"
export type { RelationshipRepairPanelState } from "./client/releases/RelationshipRepairPanelView.js"
export { ReleaseEvidence, type ReleaseEvidenceProps } from "./client/releases/ReleaseEvidence.js"
export {
  ConnectionSynchronizationView,
  type ConnectionSynchronizationViewProps
} from "./client/services/ConnectionSynchronizationView.js"
export type { ConnectionSynchronizationViewState } from "./client/services/ConnectionSynchronizationView.js"
export { ConnectionTestEvidence, type ConnectionTestEvidenceProps } from "./client/services/ConnectionTestEvidence.js"
export { ReleaseTargetsEditor, type ReleaseTargetsEditorProps } from "./client/settings/ReleaseTargetsEditor.js"
export { SettingsForm, type SettingsFormProps } from "./client/settings/SettingsForm.js"
