export interface Config {
  /** Filecoin FVM RPC endpoint */
  rpcUrl: string
  /** Wallet private key (hex, with 0x prefix) */
  privateKey: `0x${string}`
  /** Deployed JobRegistry contract address */
  jobRegistryAddress: `0x${string}`
  /** Path to the fws-lambda-host prover binary */
  proverBinaryPath: string
}

export function loadConfig(): Config {
  const rpcUrl = requireEnv("FILECOIN_RPC_URL")
  const privateKey = requireEnv("PRIVATE_KEY") as `0x${string}`
  const jobRegistryAddress = requireEnv("JOB_REGISTRY_ADDRESS") as `0x${string}`
  const proverBinaryPath = process.env.PROVER_BINARY_PATH ?? "../target/release/fws-lambda-host"

  return { rpcUrl, privateKey, jobRegistryAddress, proverBinaryPath }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}
