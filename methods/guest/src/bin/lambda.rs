#![no_main]

use fws_commp::calc_commp;
use fws_lambda_core::{GuestInput, GuestOutput};
use risc0_zkvm::guest::env;

risc0_zkvm::guest::entry!(main);

fn main() {
    // Read inputs provided by the host.
    let input: GuestInput = env::read();

    // Verify input data matches the claimed CommP.
    let computed_input_commp = calc_commp(&input.input_data);
    assert_eq!(
        computed_input_commp, input.input_commp,
        "input data does not match claimed CommP"
    );

    // Verify WASM bytecode matches the claimed CommP.
    let computed_wasm_commp = calc_commp(&input.wasm_bytecode);
    assert_eq!(
        computed_wasm_commp, input.wasm_commp,
        "wasm bytecode does not match claimed CommP"
    );

    // Execute the WASM bytecode over the input data.
    let output_data = execute_wasm(&input.wasm_bytecode, &input.input_data);

    // Compute the output CommP.
    let output_commp = calc_commp(&output_data);

    // Commit public outputs to the journal as raw bytes.
    // The journal is exactly 96 bytes: inputCommp || wasmCommp || outputCommp
    // This matches what the on-chain verifier contract expects.
    env::commit_slice(&input.input_commp);
    env::commit_slice(&input.wasm_commp);
    env::commit_slice(&output_commp);
}

/// Run a WASM module over input data and return the output.
///
/// Convention: the WASM module exports:
///   - `memory`: linear memory for data exchange
///   - `process(input_ptr: i32, input_len: i32) -> i32`: processes input, returns output length
///
/// Input is written at offset 0 in WASM memory.
/// Output is read starting right after the input.
fn execute_wasm(wasm_bytecode: &[u8], input_data: &[u8]) -> Vec<u8> {
    use wasmi::*;

    let engine = Engine::default();
    let module = Module::new(&engine, wasm_bytecode).expect("failed to parse wasm module");

    let mut store = Store::new(&engine, ());
    let linker = Linker::<()>::new(&engine);

    let instance = linker
        .instantiate(&mut store, &module)
        .expect("failed to instantiate wasm module")
        .start(&mut store)
        .expect("failed to start wasm module");

    // Get the module's exported memory.
    let memory = instance
        .get_memory(&store, "memory")
        .expect("wasm module must export memory");

    // Write input data into WASM memory at offset 0.
    memory
        .write(&mut store, 0, input_data)
        .expect("failed to write input to wasm memory");

    // Call the exported `process` function.
    let process = instance
        .get_typed_func::<(i32, i32), i32>(&store, "process")
        .expect("wasm module must export `process(i32, i32) -> i32`");

    let output_len = process
        .call(&mut store, (0, input_data.len() as i32))
        .expect("wasm process function failed");

    // Read output from memory right after the input.
    let output_offset = input_data.len();
    let mut output = vec![0u8; output_len as usize];
    memory
        .read(&store, output_offset, &mut output)
        .expect("failed to read output from wasm memory");

    output
}
