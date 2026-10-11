/** Host-local, read-only package boundary; raw provider clients and authority layers stay private. @module */
export { CodeCoordinates, CodeHostReadError, type CodeReferenceStore } from "./host-model.js"
export { type CodeHostReads, makeCodeHostReads } from "./host-read.js"
