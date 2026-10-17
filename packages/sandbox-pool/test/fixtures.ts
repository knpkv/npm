import { Schema } from "effect"
import { PoolContract } from "../src/index.js"

/** An invented pool: no real organization's IDs or names. */
export const contractInput = {
  accounts: [
    { name: "sandbox-a", accountId: "111111111111" },
    { name: "sandbox-b", accountId: "222222222222" }
  ],
  nukeBlocklist: ["333333333333", "444444444444"],
  regions: ["eu-central-1", "us-east-1"],
  accountAccessRole: "PoolAccessRole",
  boundaryPath: "/pool/",
  boundaryName: "PoolBoundary",
  accountAliasPrefix: "example-pool-",
  budgetActionRole: "example-pool-budget-action",
  denyAllPolicy: "PoolDenyAll"
}

export const contract = Schema.decodeUnknownSync(PoolContract)(contractInput)
