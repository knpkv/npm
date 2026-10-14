/** Leave optional local enrichment time to finish before a remote directory read expires. */
import { connectWriteTimeoutMillis } from "./sqlite-write.js"

export const connectPeerDirectoryTimeoutMillis = 1_500

const reportTransportMarginMillis = 1_000
export const connectPeerReporterTimeoutMillis = connectWriteTimeoutMillis + reportTransportMarginMillis

/** A report response can include reporter inventory, its primary write, and the final transport margin. */
export const connectReportResponseTimeoutMillis = connectPeerReporterTimeoutMillis + connectWriteTimeoutMillis +
  reportTransportMarginMillis
