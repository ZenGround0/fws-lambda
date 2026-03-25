use anyhow::{ensure, Result};
use clap::Parser;
use fws_commp::calc_commp;
use fws_lambda_core::GuestInput;
use fws_lambda_methods::LAMBDA_ELF;
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts, InnerReceipt};
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

    /// Directory to write output files (seal.bin, journal.bin, output.bin)
    #[arg(long)]
    output_dir: Option<String>,
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
        input_data: input_data.clone(),
        wasm_bytecode: wasm_bytecode.clone(),
    };

    // Set up the executor environment with the guest input.
    let env = ExecutorEnv::builder().write(&guest_input)?.build()?;

    // Run the prover with Groth16 output for on-chain verification.
    let prover = default_prover();
    let prove_info = prover.prove_with_opts(env, LAMBDA_ELF, &ProverOpts::groth16())?;
    let receipt = prove_info.receipt;

    // The journal is raw bytes: inputCommp(32) || wasmCommp(32) || outputCommp(32)
    let journal_bytes = receipt.journal.bytes.clone();
    ensure!(journal_bytes.len() == 96, "unexpected journal length: {}", journal_bytes.len());

    let mut output_commp = [0u8; 32];
    output_commp.copy_from_slice(&journal_bytes[64..96]);

    // Verify the receipt locally.
    receipt.verify(fws_lambda_methods::LAMBDA_ID)?;
    info!("receipt verified locally");

    // Re-execute WASM natively to capture the output data.
    // This is fast (no proving overhead) and lets us get the actual output bytes.
    let output_data = execute_wasm_native(&wasm_bytecode, &input_data)?;

    // Verify the native execution matches what the guest proved.
    let computed_output_commp = calc_commp(&output_data);
    ensure!(
        computed_output_commp == output_commp,
        "native WASM execution produced different output than proven"
    );

    println!("Proof generated successfully!");
    println!("  Input CommP:  {}", hex::encode(input_commp));
    println!("  WASM CommP:   {}", hex::encode(wasm_commp));
    println!("  Output CommP: {}", hex::encode(output_commp));
    println!("  Output size:  {} bytes", output_data.len());

    // Write output files if requested.
    if let Some(dir) = &args.output_dir {
        std::fs::create_dir_all(dir)?;

        // Extract the Groth16 seal bytes for on-chain verification.
        let seal_bytes = match &receipt.inner {
            InnerReceipt::Groth16(groth16_receipt) => {
                groth16_receipt.seal.clone()
            }
            other => {
                anyhow::bail!("expected Groth16 receipt, got {:?}", std::mem::discriminant(other));
            }
        };

        std::fs::write(format!("{dir}/seal.bin"), &seal_bytes)?;
        std::fs::write(format!("{dir}/journal.bin"), &journal_bytes)?;
        std::fs::write(format!("{dir}/output.bin"), &output_data)?;
        println!("  Seal size:     {} bytes", seal_bytes.len());
        println!("  Output written to {dir}/");
    }

    Ok(())
}

/// Execute WASM natively (outside the zkVM) to capture output data.
fn execute_wasm_native(wasm_bytecode: &[u8], input_data: &[u8]) -> Result<Vec<u8>> {
    use wasmi::*;

    let engine = Engine::default();
    let module = Module::new(&engine, wasm_bytecode)?;

    let mut store = Store::new(&engine, ());
    let linker = Linker::<()>::new(&engine);

    let instance = linker
        .instantiate(&mut store, &module)?
        .start(&mut store)?;

    let memory = instance
        .get_memory(&store, "memory")
        .ok_or_else(|| anyhow::anyhow!("wasm module must export memory"))?;

    memory.write(&mut store, 0, input_data)?;

    let process = instance.get_typed_func::<(i32, i32), i32>(&store, "process")?;

    let output_len = process.call(&mut store, (0, input_data.len() as i32))?;

    let output_offset = input_data.len();
    let mut output = vec![0u8; output_len as usize];
    memory.read(&store, output_offset, &mut output)?;

    Ok(output)
}
