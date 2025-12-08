/**
 * HAST (Hypertext Abstract Syntax Tree) schemas.
 *
 * @module
 */
export type {
  HastComment,
  HastDoctype,
  HastElement,
  HastNode,
  HastProperties,
  HastRoot,
  HastText
} from "./HastSchema.js"

export {
  getTextContent,
  HastCommentSchema,
  HastDoctypeSchema,
  HastElementSchema,
  HastNodeSchema,
  HastPropertiesSchema,
  HastRootSchema,
  HastTextSchema,
  isHastComment,
  isHastElement,
  isHastText,
  makeHastComment,
  makeHastDoctype,
  makeHastElement,
  makeHastRoot,
  makeHastText
} from "./HastSchema.js"

export { HastFromHtml } from "./HastFromHtml.js"
