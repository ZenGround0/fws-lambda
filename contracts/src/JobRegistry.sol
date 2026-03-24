// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IJobRegistry} from "./IJobRegistry.sol";

/// @notice Minimal verifier interface matching RISC Zero's on-chain Groth16 verifier.
interface IRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}

/// @title JobRegistry
/// @notice Verifiable compute marketplace: users post jobs, workers submit ZK proofs.
/// @dev Deployed on Filecoin FVM. Uses RISC Zero Groth16 verifier for proof checking.
contract JobRegistry is IJobRegistry {
    IRiscZeroVerifier public immutable verifier;
    bytes32 public immutable imageId;

    uint256 public nextJobId;
    mapping(uint256 => Job) public jobs;

    constructor(IRiscZeroVerifier _verifier, bytes32 _imageId) {
        verifier = _verifier;
        imageId = _imageId;
    }

    function postJob(bytes32 inputCommp, bytes32 wasmCommp) external payable returns (uint256 jobId) {
        require(msg.value > 0, "bounty required");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            inputCommp: inputCommp,
            wasmCommp: wasmCommp,
            submitter: msg.sender,
            bounty: msg.value,
            status: JobStatus.Open,
            outputCommp: bytes32(0),
            worker: address(0)
        });

        emit JobPosted(jobId, inputCommp, wasmCommp, msg.sender, msg.value);
    }

    function submitProof(uint256 jobId, bytes calldata seal, bytes calldata journal) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open, "job not open");
        require(job.bounty > 0, "job does not exist");

        // Decode the journal: (inputCommp, wasmCommp, outputCommp)
        require(journal.length == 96, "invalid journal length");
        bytes32 journalInputCommp = bytes32(journal[0:32]);
        bytes32 journalWasmCommp = bytes32(journal[32:64]);
        bytes32 journalOutputCommp = bytes32(journal[64:96]);

        // Verify the journal matches the job's commitments.
        require(journalInputCommp == job.inputCommp, "input commp mismatch");
        require(journalWasmCommp == job.wasmCommp, "wasm commp mismatch");

        // Verify the ZK proof on-chain.
        bytes32 journalDigest = sha256(journal);
        verifier.verify(seal, imageId, journalDigest);

        // Proof valid — mark job complete and pay the worker.
        job.status = JobStatus.Completed;
        job.outputCommp = journalOutputCommp;
        job.worker = msg.sender;

        emit JobCompleted(jobId, journalOutputCommp, msg.sender);

        (bool sent, ) = payable(msg.sender).call{value: job.bounty}("");
        require(sent, "payment failed");
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
