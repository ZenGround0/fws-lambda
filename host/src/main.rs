use anyhow::Result;
use clap::Parser;
use fws_commp::calc_commp;
use fws_lambda_core::{GuestInput, GuestOutput};
use fws_lambda_methods::LAMBDA_ELF;
use risc0_zkvm::{default_prover, ExecutorEnv};
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "fws-lambda", about = "Verifiable compute worker node")]
struct Args {
    /// Path to the WASM job bytecode
    #[arg(long)]
    wasm: String,

    /// Path to the input data file
    #[arg(long)]
    input: String,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    // Load WASM bytecode and input data.
    let wasm_bytecode = std::fs::read(&args.wasm)?;
    let input_data = std::fs::read(&args.input)?;

    // Compute CommP commitments for both.
    let input_commp = calc_commp(&input_data);
    let wasm_commp = calc_commp(&wasm_bytecode);

    info!(
        input_size = input_data.len(),
        wasm_size = wasm_bytecode.len(),
        "starting proof generation"
    );

    // Build the guest input.
    let guest_input = GuestInput {
        input_commp,
        wasm_commp,
        input_data,
        wasm_bytecode,
    };

    // Set up the executor environment with the guest input.
    let env = ExecutorEnv::builder()
        .write(&guest_input)?
        .build()?;

    // Run the prover (uses RISC0_DEV_MODE=1 env var to skip real proving).
    let prover = default_prover();
    let prove_info = prover.prove(env, LAMBDA_ELF)?;
    let receipt = prove_info.receipt;

    // Extract the public outputs from the journal.
    let output: GuestOutput = receipt.journal.decode()?;

    println!("Proof generated successfully!");
    println!("  Input CommP:  {}", hex::encode(output.input_commp));
    println!("  WASM CommP:   {}", hex::encode(output.wasm_commp));
    println!("  Output CommP: {}", hex::encode(output.output_commp));

    // Verify the receipt locally.
    receipt.verify(fws_lambda_methods::LAMBDA_ID)?;
    println!("  Receipt verified locally.");

    Ok(())
}
