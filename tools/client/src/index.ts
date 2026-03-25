#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { parseEther, toHex, type Hex } from "viem"
import {
  loadConfig,
  createChainClients,
  createSynapseClient,
  uploadToWarmStorage,
  prepareStorage,
  cidToCommp,
  postJob,
  type PdpWitness,
} from "@fws-lambda/shared"

async function main() {
  const { values } = parseArgs({
    options: {
      wasm: { type: "string" },
      input: { type: "string" },
      bounty: { type: "string", default: "0.01" },
    },
  })

  if (!values.wasm || !values.input) {
    console.error("Usage: fws-client --wasm <path> --input <path> [--bounty <FIL>]")
    process.exit(1)
  }

  const config = loadConfig()
  const clients = createChainClients(config)
  const synapse = createSynapseClient(config)

  // Read files.
  const wasmBytes = new Uint8Array(await readFile(values.wasm))
  const inputBytes = new Uint8Array(await readFile(values.input))

  // Ensure storage account is funded and approved (no-op if already ready).
  const totalSize = wasmBytes.length + inputBytes.length
  console.log(`Preparing storage account for ${totalSize} bytes...`)
  await prepareStorage(synapse, totalSize)

  console.log(`Uploading WASM (${wasmBytes.length} bytes) to warm storage...`)
  const wasmResult = await uploadToWarmStorage(synapse, wasmBytes)
  console.log(`  WASM PieceCID: ${wasmResult.pieceCid} (${wasmResult.copies.length} copies)`)
  for (const c of wasmResult.copies) {
    console.log(`    ${c.role}: provider=${c.providerId} dataSet=${c.dataSetId} pieceId=${c.pieceId}`)
  }

  console.log(`Uploading input (${inputBytes.length} bytes) to warm storage...`)
  const inputResult = await uploadToWarmStorage(synapse, inputBytes)
  console.log(`  Input PieceCID: ${inputResult.pieceCid} (${inputResult.copies.length} copies)`)
  for (const c of inputResult.copies) {
    console.log(`    ${c.role}: provider=${c.providerId} dataSet=${c.dataSetId} pieceId=${c.pieceId}`)
  }

  // Extract CommP from CIDs for on-chain submission.
  const wasmCommp = toHex(cidToCommp(wasmResult.pieceCid))
  const inputCommp = toHex(cidToCommp(inputResult.pieceCid))

  // Use the primary copy's PDP location as the on-chain witness.
  const inputPrimary = inputResult.copies.find(c => c.role === "primary") ?? inputResult.copies[0]
  const wasmPrimary = wasmResult.copies.find(c => c.role === "primary") ?? wasmResult.copies[0]

  const inputWitness: PdpWitness = {
    dataSetId: inputPrimary.dataSetId,
    pieceId: inputPrimary.pieceId,
  }
  const wasmWitness: PdpWitness = {
    dataSetId: wasmPrimary.dataSetId,
    pieceId: wasmPrimary.pieceId,
  }

  const bountyWei = parseEther(values.bounty!)
  console.log(`Posting job on-chain with ${values.bounty} FIL bounty...`)

  const result = await postJob(
    clients,
    config.jobRegistryAddress,
    inputCommp,
    wasmCommp,
    bountyWei,
    inputWitness,
    wasmWitness,
  )

  console.log(`Job posted!`)
  console.log(`  Job ID: ${result.jobId}`)
  console.log(`  TX: ${result.txHash}`)
  console.log(`  Input CommP CID: ${inputResult.pieceCid}`)
  console.log(`  WASM CommP CID: ${wasmResult.pieceCid}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
