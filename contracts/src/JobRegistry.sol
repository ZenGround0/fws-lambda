// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IJobRegistry} from "./IJobRegistry.sol";
import {Cids} from "pdp/Cids.sol";

/// @notice Minimal verifier interface matching RISC Zero's on-chain Groth16 verifier.
interface IRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}

/// @notice Minimal interface for querying the PDP Verifier contract.
interface IPDPVerifierRead {
    function pieceLive(uint256 setId, uint256 pieceId) external view returns (bool);
    function getPieceCid(uint256 setId, uint256 pieceId) external view returns (Cids.Cid memory);
}

/// @title JobRegistry
/// @notice Verifiable compute marketplace with PDP-backed data availability guarantees.
/// @dev Jobs are only accepted when input data is provably in PDP warm storage.
///      Payment is only released when output data is also committed to PDP.
contract JobRegistry is IJobRegistry {
    IRiscZeroVerifier public immutable verifier;
    IPDPVerifierRead public immutable pdpVerifier;
    bytes32 public immutable imageId;

    uint256 public nextJobId;
    mapping(uint256 => Job) public jobs;

    constructor(IRiscZeroVerifier _verifier, IPDPVerifierRead _pdpVerifier, bytes32 _imageId) {
        verifier = _verifier;
        pdpVerifier = _pdpVerifier;
        imageId = _imageId;
    }

    function postJob(
        bytes32 inputCommp,
        bytes32 wasmCommp,
        PdpWitness calldata inputWitness,
        PdpWitness calldata wasmWitness
    ) external payable returns (uint256 jobId) {
        require(msg.value > 0, "bounty required");

        // Verify input data exists in PDP.
        _verifyPdpWitness(inputCommp, inputWitness);

        // Verify WASM bytecode exists in PDP.
        _verifyPdpWitness(wasmCommp, wasmWitness);

        jobId = nextJobId++;
        jobs[jobId] = Job({
            inputCommp: inputCommp,
            wasmCommp: wasmCommp,
            submitter: msg.sender,
            bounty: msg.value,
            status: JobStatus.Open,
            outputCommp: bytes32(0),
            worker: address(0),
            inputWitness: inputWitness,
            wasmWitness: wasmWitness
        });

        emit JobPosted(jobId, inputCommp, wasmCommp, msg.sender, msg.value);
    }

    function submitProof(
        uint256 jobId,
        bytes calldata seal,
        bytes calldata journal,
        PdpWitness calldata outputWitness
    ) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Open, "job not open");
        require(job.bounty > 0, "job does not exist");

        // Decode the journal: inputCommp(32) || wasmCommp(32) || outputCommp(32)
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

        // Verify output data has been committed to PDP before releasing payment.
        _verifyPdpWitness(journalOutputCommp, outputWitness);

        // Proof valid + output in PDP → mark job complete and pay the worker.
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

    /// @dev Verify that a CommP digest matches a live piece in PDP.
    ///      Extracts the digest from the on-chain CommPv2 CID and compares
    ///      it to the expected CommP bytes32.
    function _verifyPdpWitness(bytes32 expectedCommp, PdpWitness calldata witness) internal view {
        // Check the piece is alive in the PDP dataset.
        require(
            pdpVerifier.pieceLive(witness.dataSetId, witness.pieceId),
            "piece not live in PDP"
        );

        // Get the on-chain CID and extract its digest.
        Cids.Cid memory onchainCid = pdpVerifier.getPieceCid(witness.dataSetId, witness.pieceId);
        bytes32 onchainDigest = Cids.digestFromCid(onchainCid);

        require(onchainDigest == expectedCommp, "commp does not match PDP piece");
    }
}
