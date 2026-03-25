import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { filecoinCalibration, filecoin } from "viem/chains"
import type { Config } from "./config.ts"

export interface PdpWitness {
  dataSetId: bigint
  pieceId: bigint
}

// JobRegistry ABI — just the functions and events we need.
const JOB_REGISTRY_ABI = parseAbi([
  "function postJob(bytes32 inputCommp, bytes32 wasmCommp, (uint256, uint256) inputWitness, (uint256, uint256) wasmWitness) external payable returns (uint256)",
  "function submitProof(uint256 jobId, bytes seal, bytes journal, (uint256, uint256) outputWitness) external",
  "function getJob(uint256 jobId) external view returns ((bytes32, bytes32, address, uint256, uint8, bytes32, address, (uint256, uint256), (uint256, uint256)))",
  "function nextJobId() external view returns (uint256)",
  "event JobPosted(uint256 indexed jobId, bytes32 inputCommp, bytes32 wasmCommp, address indexed submitter, uint256 bounty)",
  "event JobCompleted(uint256 indexed jobId, bytes32 outputCommp, address indexed worker)",
])

export interface ChainClients {
  publicClient: PublicClient
  walletClient: WalletClient
}

export function createChainClients(config: Config): ChainClients {
  const chain = config.rpcUrl.includes("calibration") ? filecoinCalibration : filecoin
  const account = privateKeyToAccount(config.privateKey)

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  }) as PublicClient

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  })

  return { publicClient, walletClient }
}

/** Post a new compute job. Returns the jobId. */
export async function postJob(
  clients: ChainClients,
  contractAddress: Hex,
  inputCommp: Hex,
  wasmCommp: Hex,
  bountyWei: bigint,
  inputWitness: PdpWitness,
  wasmWitness: PdpWitness,
): Promise<{ jobId: bigint; txHash: Hex }> {
  const { publicClient, walletClient } = clients

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: JOB_REGISTRY_ABI,
    functionName: "postJob",
    args: [
      inputCommp,
      wasmCommp,
      [inputWitness.dataSetId, inputWitness.pieceId],
      [wasmWitness.dataSetId, wasmWitness.pieceId],
    ],
    value: bountyWei,
    chain: walletClient.chain,
  } as any)

  await publicClient.waitForTransactionReceipt({ hash: txHash })

  const nextJobId = (await publicClient.readContract({
    address: contractAddress,
    abi: JOB_REGISTRY_ABI,
    functionName: "nextJobId",
  })) as bigint
  const jobId = nextJobId - 1n

  return { jobId, txHash }
}

/** Submit a ZK proof for a job. */
export async function submitProof(
  clients: ChainClients,
  contractAddress: Hex,
  jobId: bigint,
  seal: Hex,
  journal: Hex,
  outputWitness: PdpWitness,
): Promise<{ txHash: Hex }> {
  const { publicClient, walletClient } = clients

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: JOB_REGISTRY_ABI,
    functionName: "submitProof",
    args: [jobId, seal, journal, [outputWitness.dataSetId, outputWitness.pieceId]],
    chain: walletClient.chain,
  } as any)

  await publicClient.waitForTransactionReceipt({ hash: txHash })
  return { txHash }
}

/** Watch for new JobPosted events. */
export function watchJobPosted(
  clients: ChainClients,
  contractAddress: Hex,
  callback: (event: {
    jobId: bigint
    inputCommp: Hex
    wasmCommp: Hex
    submitter: Hex
    bounty: bigint
  }) => void,
): () => void {
  const unwatch = clients.publicClient.watchContractEvent({
    address: contractAddress,
    abi: JOB_REGISTRY_ABI,
    eventName: "JobPosted",
    onLogs: (logs: any[]) => {
      for (const log of logs) {
        callback(log.args)
      }
    },
  })

  return unwatch
}

/** Read the full CommPv2 CID bytes from the PDP verifier for a given piece. */
export async function getPieceCidFromPdp(
  clients: ChainClients,
  pdpVerifierAddress: Hex,
  dataSetId: bigint,
  pieceId: bigint,
): Promise<Hex> {
  const PDP_ABI = parseAbi([
    "function getPieceCid(uint256 setId, uint256 pieceId) external view returns ((bytes))",
  ])

  const result = await clients.publicClient.readContract({
    address: pdpVerifierAddress,
    abi: PDP_ABI,
    functionName: "getPieceCid",
    args: [dataSetId, pieceId],
  }) as readonly [Hex]

  return result[0]
}

/** Read job details from the contract. */
export async function getJob(
  clients: ChainClients,
  contractAddress: Hex,
  jobId: bigint,
) {
  return await clients.publicClient.readContract({
    address: contractAddress,
    abi: JOB_REGISTRY_ABI,
    functionName: "getJob",
    args: [jobId],
  })
}
