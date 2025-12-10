/**
 * @knpkv/confluence-api-client
 *
 * Effect-based Confluence Cloud REST API client (v1 + v2).
 *
 * @packageDocumentation
 */

export { ConfluenceApiConfig, type ConfluenceApiConfigShape } from "./ConfluenceApiConfig.js"

export { ConfluenceApiClient, type ConfluenceApiClientShape, layer } from "./ConfluenceApiClient.js"

// Re-export V1 types
export type {
  ApiError as V1ApiError,
  ConfluenceV1Client,
  ContentProperty as V1ContentProperty,
  ContentPropertyRequest as V1ContentPropertyRequest,
  User as V1User
} from "./generated/v1/Client.js"

// Re-export V2 types
export type {
  ApiError as V2ApiError,
  ConfluenceV2Client,
  CreatePageRequest,
  GetChildrenParams,
  GetPageParams,
  GetVersionsParams,
  Page,
  PageBody,
  PageChildrenResponse,
  PageLinks,
  PageListItem,
  PageVersion,
  PageVersionsResponse,
  PageVersionWithBody,
  UpdatePageRequest
} from "./generated/v2/Client.js"
