#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
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
  base32Encode,
  submitProof,
  watchJobPosted,
  getJob,
  getPieceCidFromPdp,
  type PdpWitness,
} from "@fws-lambda/shared"

async function main() {
  const { values } = parseArgs({
    options: {
      "job-id": { type: "string" },
      watch: { type: "boolean", default: false },
    },
  })

  const config = loadConfig()
  const clients = createChainClients(config)
  const synapse = createSynapseClient(config)

  if (values["job-id"] != null) {
    // Direct mode: process a specific job by ID.
    const jobId = BigInt(values["job-id"])
    console.log(`Processing job ${jobId}...`)

    const job = await getJob(clients, config.jobRegistryAddress, jobId) as any
    // Unnamed tuple: [inputCommp, wasmCommp, submitter, bounty, status, outputCommp, worker, [inputDS, inputPiece], [wasmDS, wasmPiece]]
    const inputCommp = job[0] as Hex
    const wasmCommp = job[1] as Hex
    const bounty = job[3] as bigint
    const status = Number(job[4])
    const inputWitness = { dataSetId: job[7][0] as bigint, pieceId: job[7][1] as bigint }
    const wasmWitness = { dataSetId: job[8][0] as bigint, pieceId: job[8][1] as bigint }

    if (status !== 0) {
      console.error(`Job ${jobId} is not open (status=${status})`)
      process.exit(1)
    }

    console.log(`  Input CommP: ${inputCommp}`)
    console.log(`  WASM CommP:  ${wasmCommp}`)
    console.log(`  Bounty:      ${bounty} wei`)
    console.log(`  Input PDP:   dataSet=${inputWitness.dataSetId} pieceId=${inputWitness.pieceId}`)
    console.log(`  WASM PDP:    dataSet=${wasmWitness.dataSetId} pieceId=${wasmWitness.pieceId}`)

    await processJob(config, clients, synapse, {
      jobId,
      inputCommp,
      wasmCommp,
      inputWitness,
      wasmWitness,
    })
  } else if (values.watch) {
    // Daemon mode: watch for new jobs.
    console.log("Worker started. Watching for JobPosted events...")

    watchJobPosted(clients, config.jobRegistryAddress, async (event) => {
      console.log(`\nJob ${event.jobId} posted by ${event.submitter}`)
      console.log(`  Bounty: ${event.bounty} wei`)

      try {
        // In daemon mode, read the full job to get PDP witnesses.
        const fullJob = await getJob(clients, config.jobRegistryAddress, event.jobId) as any
        await processJob(config, clients, synapse, {
          jobId: event.jobId,
          inputCommp: event.inputCommp,
          wasmCommp: event.wasmCommp,
          inputWitness: { dataSetId: fullJob[7][0] as bigint, pieceId: fullJob[7][1] as bigint },
          wasmWitness: { dataSetId: fullJob[8][0] as bigint, pieceId: fullJob[8][1] as bigint },
        })
      } catch (err) {
        console.error(`  Job ${event.jobId} failed:`, err)
      }
    })

    await new Promise(() => {})
  } else {
    console.error("Usage:")
    console.error("  fws-worker --job-id <id>    Process a specific job")
    console.error("  fws-worker --watch          Watch for new jobs (daemon)")
    process.exit(1)
  }
}

async function processJob(
  config: ReturnType<typeof loadConfig>,
  clients: ReturnType<typeof createChainClients>,
  synapse: ReturnType<typeof createSynapseClient>,
  job: {
    jobId: bigint
    inputCommp: Hex
    wasmCommp: Hex
    inputWitness?: PdpWitness
    wasmWitness?: PdpWitness
  },
) {
  // Get the full CommPv2 CIDs from PDP for downloading.
  // We need the PDP witness (dataSetId, pieceId) to look up the CID.
  let inputCid: string
  let wasmCid: string

  if (job.inputWitness && job.wasmWitness) {
    // Read full CIDs from PDP verifier contract.
    const inputCidBytes = await getPieceCidFromPdp(
      clients, config.pdpVerifierAddress,
      job.inputWitness.dataSetId, job.inputWitness.pieceId,
    )
    const wasmCidBytes = await getPieceCidFromPdp(
      clients, config.pdpVerifierAddress,
      job.wasmWitness.dataSetId, job.wasmWitness.pieceId,
    )
    // Encode as multibase base32lower CID strings for Synapse.
    inputCid = "b" + base32Encode(hexToBytes(inputCidBytes))
    wasmCid = "b" + base32Encode(hexToBytes(wasmCidBytes))
  } else {
    // Fallback: construct CommPv1 CID from digest (may not work with Synapse).
    inputCid = commpToCid(hexToBytes(job.inputCommp))
    wasmCid = commpToCid(hexToBytes(job.wasmCommp))
  }

  console.log(`  Downloading input data (CID: ${inputCid})...`)
  const inputData = await downloadFromWarmStorage(synapse, inputCid)
  console.log(`  Downloaded input: ${inputData.length} bytes`)

  console.log(`  Downloading WASM bytecode (CID: ${wasmCid})...`)
  const wasmData = await downloadFromWarmStorage(synapse, wasmCid)
  console.log(`  Downloaded WASM: ${wasmData.length} bytes`)

  // Write to temp files for the prover binary.
  const workDir = await mkdtemp(join(tmpdir(), `fws-job-${job.jobId}-`))
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
  const sealBytes = await readFile(join(outputDir, "seal.bin"))
  const journalBytes = await readFile(join(outputDir, "journal.bin"))
  const outputData = await readFile(join(outputDir, "output.bin"))
  console.log(`  Seal size: ${sealBytes.length} bytes`)

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
  const seal = toHex(new Uint8Array(sealBytes))
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
    job.jobId,
    seal,
    journal,
    outputWitness,
  )

  console.log(`  Job ${job.jobId} completed! TX: ${result.txHash}`)

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
