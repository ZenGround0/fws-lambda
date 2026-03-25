import { Synapse } from "@filoz/synapse-sdk"
import type { Client, Transport, Chain, Account } from "viem"

let synapseInstance: Synapse | null = null

/** Initialize the Synapse SDK client. */
export function createSynapseClient(walletClient: Client<Transport, Chain, Account>): Synapse {
  synapseInstance = new Synapse({
    client: walletClient as any,
    source: "fws-lambda",
  })
  return synapseInstance
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
    const errors = result.failedAttempts.map((f: any) => f.error).join(", ")
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
