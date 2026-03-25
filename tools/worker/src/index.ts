#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toHex, type Hex } from "viem"
import {
  loadConfig,
  createChainClients,
  createSynapseClient,
  downloadFromWarmStorage,
  uploadToWarmStorage,
  prepareStorage,
  commpToCid,
  cidToCommp,
  submitProof,
  watchJobPosted,
  getJob,
  type PdpWitness,
} from "@fws-lambda/shared"

async function main() {
  const config = loadConfig()
  const clients = createChainClients(config)
  const synapse = createSynapseClient(clients.walletClient as any)

  console.log("Worker started. Watching for JobPosted events...")

  watchJobPosted(clients, config.jobRegistryAddress, async (event) => {
    console.log(`\nJob ${event.jobId} posted by ${event.submitter}`)
    console.log(`  Bounty: ${event.bounty} wei`)

    try {
      await processJob(config, clients, synapse, event)
    } catch (err) {
      console.error(`  Job ${event.jobId} failed:`, err)
    }
  })

  // Keep the process running.
  await new Promise(() => {})
}

async function processJob(
  config: ReturnType<typeof loadConfig>,
  clients: ReturnType<typeof createChainClients>,
  synapse: ReturnType<typeof createSynapseClient>,
  event: {
    jobId: bigint
    inputCommp: Hex
    wasmCommp: Hex
    submitter: Hex
    bounty: bigint
  },
) {
  // Convert on-chain CommP bytes32 to PieceCIDs for Synapse download.
  const inputCommpBytes = hexToBytes(event.inputCommp)
  const wasmCommpBytes = hexToBytes(event.wasmCommp)
  const inputCid = commpToCid(inputCommpBytes)
  const wasmCid = commpToCid(wasmCommpBytes)

  console.log(`  Downloading input data (CID: ${inputCid})...`)
  const inputData = await downloadFromWarmStorage(synapse, inputCid)

  console.log(`  Downloading WASM bytecode (CID: ${wasmCid})...`)
  const wasmData = await downloadFromWarmStorage(synapse, wasmCid)

  // Write to temp files for the prover binary.
  const workDir = await mkdtemp(join(tmpdir(), `fws-job-${event.jobId}-`))
  const wasmPath = join(workDir, "wasm.bin")
  const inputPath = join(workDir, "input.bin")
  const outputDir = join(workDir, "out")

  await writeFile(wasmPath, wasmData)
  await writeFile(inputPath, inputData)

  console.log(`  Running prover...`)
  try {
    execFileSync(config.proverBinaryPath, [
      "--wasm", wasmPath,
      "--input", inputPath,
      "--output-dir", outputDir,
    ], {
      stdio: "inherit",
      env: { ...process.env },
    })
  } catch (err) {
    throw new Error(`Prover failed: ${err}`)
  }

  // Read prover outputs.
  const receiptBytes = await readFile(join(outputDir, "receipt.bin"))
  const journalBytes = await readFile(join(outputDir, "journal.bin"))
  const outputData = await readFile(join(outputDir, "output.bin"))

  // Ensure storage account is funded for the output upload.
  await prepareStorage(synapse, outputData.length)

  // Upload output data to warm storage.
  console.log(`  Uploading output data (${outputData.length} bytes)...`)
  const outputResult = await uploadToWarmStorage(synapse, new Uint8Array(outputData))
  console.log(`  Output PieceCID: ${outputResult.pieceCid}`)
  for (const c of outputResult.copies) {
    console.log(`    ${c.role}: provider=${c.providerId} dataSet=${c.dataSetId} pieceId=${c.pieceId}`)
  }

  // Submit proof on-chain.
  // The seal is the receipt minus the journal — for now pass the full receipt.
  // TODO: Extract the actual Groth16 seal from the receipt for production use.
  const seal = toHex(new Uint8Array(receiptBytes))
  const journal = toHex(new Uint8Array(journalBytes))

  // Build PDP witness for the output using the primary copy.
  const outputPrimary = outputResult.copies.find(c => c.role === "primary") ?? outputResult.copies[0]
  const outputWitness: PdpWitness = {
    dataSetId: outputPrimary.dataSetId,
    pieceId: outputPrimary.pieceId,
  }

  console.log(`  Submitting proof on-chain...`)
  const result = await submitProof(
    clients,
    config.jobRegistryAddress,
    event.jobId,
    seal,
    journal,
    outputWitness,
  )

  console.log(`  Job ${event.jobId} completed! TX: ${result.txHash}`)

  // Cleanup temp files.
  await rm(workDir, { recursive: true, force: true })
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
