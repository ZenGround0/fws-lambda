// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IJobRegistry {
    enum JobStatus {
        Open,
        Completed
    }

    /// A PDP location witness: proves a CommP lives in a specific PDP dataset.
    struct PdpWitness {
        uint256 dataSetId;
        uint256 pieceId;
    }

    struct Job {
        bytes32 inputCommp;
        bytes32 wasmCommp;
        address submitter;
        uint256 bounty;
        JobStatus status;
        bytes32 outputCommp;
        address worker;
        // PDP witnesses for input and wasm data
        PdpWitness inputWitness;
        PdpWitness wasmWitness;
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

    /// Post a new compute job. Caller provides CommP values plus PDP witnesses
    /// proving the data actually exists in warm storage. Sends FIL as bounty.
    function postJob(
        bytes32 inputCommp,
        bytes32 wasmCommp,
        PdpWitness calldata inputWitness,
        PdpWitness calldata wasmWitness
    ) external payable returns (uint256 jobId);

    /// Submit a proof that transforms inputCommp → outputCommp using wasmCommp.
    /// Worker must also provide a PDP witness proving the output data has been
    /// committed to warm storage before payment is released.
    function submitProof(
        uint256 jobId,
        bytes calldata seal,
        bytes calldata journal,
        PdpWitness calldata outputWitness
    ) external;

    /// Read job details.
    function getJob(uint256 jobId) external view returns (Job memory);
}
