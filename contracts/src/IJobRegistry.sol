// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IJobRegistry {
    enum JobStatus {
        Open,
        Completed
    }

    struct Job {
        bytes32 inputCommp;
        bytes32 wasmCommp;
        address submitter;
        uint256 bounty;
        JobStatus status;
        bytes32 outputCommp;
        address worker;
    }

    event JobPosted(
        uint256 indexed jobId,
        bytes32 inputCommp,
        bytes32 wasmCommp,
        address indexed submitter,
        uint256 bounty
    );

    event JobCompleted(
        uint256 indexed jobId,
        bytes32 outputCommp,
        address indexed worker
    );

    /// Post a new compute job with input data and WASM code referenced by CommP.
    /// Caller sends FIL as the bounty (held in escrow).
    function postJob(bytes32 inputCommp, bytes32 wasmCommp) external payable returns (uint256 jobId);

    /// Submit a proof that transforms inputCommp → outputCommp using wasmCommp.
    /// The seal is verified against the RISC Zero Groth16 verifier on-chain.
    function submitProof(uint256 jobId, bytes calldata seal, bytes calldata journal) external;

    /// Read job details.
    function getJob(uint256 jobId) external view returns (Job memory);
}
