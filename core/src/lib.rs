#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;

use alloy_sol_types::sol;
use serde::{Deserialize, Serialize};

/// Input fed to the zkVM guest program.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GuestInput {
    /// Expected CommP of the input data (from on-chain job posting).
    pub input_commp: [u8; 32],
    /// Expected CommP of the WASM bytecode (from on-chain job posting).
    pub wasm_commp: [u8; 32],
    /// Raw input data fetched from Filecoin PDP.
    pub input_data: alloc::vec::Vec<u8>,
    /// WASM bytecode fetched from Filecoin PDP.
    pub wasm_bytecode: alloc::vec::Vec<u8>,
}

/// Output committed by the zkVM guest to the journal (public outputs).
/// These are the public values anyone can read from the proof.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GuestOutput {
    /// CommP of the input data (verified inside guest).
    pub input_commp: [u8; 32],
    /// CommP of the WASM bytecode (verified inside guest).
    pub wasm_commp: [u8; 32],
    /// CommP of the output data produced by the WASM execution.
    pub output_commp: [u8; 32],
}

// Solidity-compatible ABI types for on-chain interaction.
sol! {
    /// Emitted when a new job is posted.
    event JobPosted(
        uint256 indexed jobId,
        bytes32 inputCommp,
        bytes32 wasmCommp,
        address indexed submitter,
        uint256 bounty
    );

    /// Emitted when a job is completed and payment released.
    event JobCompleted(
        uint256 indexed jobId,
        bytes32 outputCommp,
        address indexed worker
    );
}
