import { Synapse } from "@filoz/synapse-sdk"
import { createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { getChain } from "@filoz/synapse-core/chains"
import type { Config } from "./config.ts"

/** Initialize the Synapse SDK client using synapse-core's chain definitions. */
export function createSynapseClient(config: Config): Synapse {
  const chain = getChain(config.rpcUrl.includes("calibration") ? 314159 : 314)
  const account = privateKeyToAccount(config.privateKey)
  const client = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  })
  return new Synapse({
    client,
    source: "fws-lambda",
  })
}

export interface UploadInfo {
  pieceCid: string
  copies: {
    providerId: bigint
    dataSetId: bigint
    pieceId: bigint
    role: string
    retrievalUrl: string
  }[]
}

/**
 * Upload data to Filecoin warm storage via Synapse.
 *
 * This blocks until the data is committed on-chain with confirmed transactions
 * and assigned a pieceId in the PDP Verifier contract. The data is queryable
 * on-chain via getActivePieces() after this returns.
 */
export async function uploadToWarmStorage(
  synapse: Synapse,
  data: Uint8Array,
): Promise<UploadInfo> {
  const result = await synapse.storage.upload(data)

  if (!result.complete) {
    console.error("Upload failed. Details:")
    console.error("  Copies:", JSON.stringify(result.copies, (_, v) => typeof v === "bigint" ? v.toString() : v, 2))
    console.error("  Failed attempts:", JSON.stringify(result.failedAttempts, (_, v) => typeof v === "bigint" ? v.toString() : v, 2))
    const errors = result.failedAttempts.map((f: any) => {
      const err = f.error
      return typeof err === "object" ? JSON.stringify(err, (_, v) => typeof v === "bigint" ? v.toString() : v) : String(err)
    }).join("; ")
    throw new Error(`Upload incomplete: ${errors}`)
  }

  return {
    pieceCid: result.pieceCid.toString(),
    copies: result.copies.map((c: any) => ({
      providerId: c.providerId,
      dataSetId: c.dataSetId,
      pieceId: c.pieceId,
      role: c.role,
      retrievalUrl: c.retrievalUrl,
    })),
  }
}

/**
 * Ensure the Synapse account is funded and approved for uploading.
 * Checks current deposit/approval state and only submits a transaction
 * if one is actually needed (idempotent).
 */
export async function prepareStorage(
  synapse: Synapse,
  dataSize: number,
): Promise<void> {
  const prepared = await synapse.storage.prepare({ dataSize: BigInt(dataSize) })

  if (prepared.transaction) {
    console.log(`  Deposit needed: ${prepared.costs.depositNeeded} USDFC`)
    console.log(`  Submitting deposit/approval transaction...`)
    await prepared.transaction.execute({
      onHash: (hash: string) => console.log(`  TX: ${hash}`),
    })
    console.log(`  Storage account ready.`)
  }
}

/** Download data from Filecoin warm storage by PieceCID. */
export async function downloadFromWarmStorage(
  synapse: Synapse,
  pieceCid: string,
): Promise<Uint8Array> {
  const data = await synapse.storage.download({ pieceCid })
  return new Uint8Array(data)
}
