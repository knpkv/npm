/**
 * Root barrel export for `@knpkv/jira-cli`.
 *
 * @module
 */

export {
  AttachmentService,
  type AttachmentServiceShape,
  layer as AttachmentServiceLayer,
  type UploadAttachmentInput
} from "./AttachmentService.js"
export {
  type Attachment,
  type Comment,
  type Issue,
  IssueService,
  type IssueServiceShape,
  layer as IssueServiceLayer,
  type SearchOptions,
  type SearchResult,
  SiteUrl
} from "./IssueService.js"
export {
  type AccessibleSite,
  JiraAuth,
  type JiraAuthService,
  layer as JiraAuthLayer,
  type LoginOptions
} from "./JiraAuth.js"
export * from "./JiraCliError.js"
export { layer as MarkdownWriterLayer, MarkdownWriter, type MarkdownWriterShape } from "./MarkdownWriter.js"
