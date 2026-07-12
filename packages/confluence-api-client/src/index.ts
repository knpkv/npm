/**
 * Schema-backed Effect clients for the Confluence Cloud REST APIs.
 *
 * @packageDocumentation
 */

export { ConfluenceApiConfig, type ConfluenceApiConfigShape } from "./ConfluenceApiConfig.js"

export {
  ConfluenceApiClient,
  type ConfluenceApiClientShape,
  layer,
  make,
  makeV1,
  makeV2,
  type UploadAttachmentInput
} from "./ConfluenceApiClient.js"

export * as ConfluenceV1Api from "./generated/ConfluenceV1Api.js"
export * as ConfluenceV2Api from "./generated/ConfluenceV2Api.js"
