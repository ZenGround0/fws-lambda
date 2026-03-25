// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test, console} from "forge-std/Test.sol";
import {JobRegistry, IPDPVerifierRead, IJobRegistry} from "../src/JobRegistry.sol";
import {IRiscZeroVerifier, Receipt} from "risc0/IRiscZeroVerifier.sol";
import {Cids} from "pdp/Cids.sol";

/// @dev Mock verifier that always accepts proofs (for testing only).
contract MockVerifier is IRiscZeroVerifier {
    function verify(bytes calldata, bytes32, bytes32) external pure {}
    function verifyIntegrity(Receipt calldata) external pure {}
}

/// @dev Mock PDP verifier that returns controlled piece data.
contract MockPDPVerifier is IPDPVerifierRead {
    mapping(uint256 => mapping(uint256 => bytes32)) public pieceDigests;
    mapping(uint256 => mapping(uint256 => bool)) public pieceExists;

    function setPiece(uint256 setId, uint256 pieceId, bytes32 digest) external {
        pieceDigests[setId][pieceId] = digest;
        pieceExists[setId][pieceId] = true;
    }

    function pieceLive(uint256 setId, uint256 pieceId) external view returns (bool) {
        return pieceExists[setId][pieceId];
    }

    function getPieceCid(uint256 setId, uint256 pieceId) external view returns (Cids.Cid memory) {
        bytes32 digest = pieceDigests[setId][pieceId];
        // Build a minimal CommPv2 CID: prefix(4) + mhLength(1) + padding(1) + height(1) + digest(32)
        // Total = 39 bytes
        bytes memory cidData = new bytes(39);
        // CommPv2 prefix: 0x01559120
        cidData[0] = 0x01;
        cidData[1] = 0x55;
        cidData[2] = 0x91;
        cidData[3] = 0x20;
        // Multihash length: 34 (1 byte padding + 1 byte height + 32 byte digest)
        cidData[4] = 0x22; // 34
        // Padding: 0
        cidData[5] = 0x00;
        // Height: 0
        cidData[6] = 0x00;
        // Digest
        for (uint256 i = 0; i < 32; i++) {
            cidData[7 + i] = digest[i];
        }
        return Cids.Cid(cidData);
    }
}

contract JobRegistryTest is Test {
    JobRegistry public registry;
    MockVerifier public mockVerifier;
    MockPDPVerifier public mockPDP;
    bytes32 public constant IMAGE_ID = bytes32(uint256(0xDEAD));

    address submitter = address(0x1);
    address worker = address(0x2);

    bytes32 inputCommp = bytes32(uint256(0x1));
    bytes32 wasmCommp = bytes32(uint256(0x2));

    function setUp() public {
        mockVerifier = new MockVerifier();
        mockPDP = new MockPDPVerifier();
        registry = new JobRegistry(mockVerifier, mockPDP, IMAGE_ID);
        vm.deal(submitter, 10 ether);
        vm.deal(worker, 1 ether);

        // Register pieces in mock PDP.
        mockPDP.setPiece(100, 1, inputCommp);  // input at dataset=100, piece=1
        mockPDP.setPiece(200, 5, wasmCommp);   // wasm at dataset=200, piece=5
    }

    function test_postJob() public {
        IJobRegistry.PdpWitness memory inputW = IJobRegistry.PdpWitness(100, 1);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp, inputW, wasmW);

        IJobRegistry.Job memory job = registry.getJob(jobId);
        assertEq(job.inputCommp, inputCommp);
        assertEq(job.wasmCommp, wasmCommp);
        assertEq(job.submitter, submitter);
        assertEq(job.bounty, 1 ether);
        assertEq(uint8(job.status), uint8(IJobRegistry.JobStatus.Open));
        assertEq(job.inputWitness.dataSetId, 100);
        assertEq(job.inputWitness.pieceId, 1);
    }

    function test_postJob_requiresBounty() public {
        IJobRegistry.PdpWitness memory w = IJobRegistry.PdpWitness(100, 1);
        vm.prank(submitter);
        vm.expectRevert("bounty required");
        registry.postJob(inputCommp, wasmCommp, w, w);
    }

    function test_postJob_rejectsInvalidInputWitness() public {
        // Witness points to a piece that doesn't exist in PDP.
        IJobRegistry.PdpWitness memory badW = IJobRegistry.PdpWitness(999, 99);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        vm.expectRevert("piece not live in PDP");
        registry.postJob{value: 1 ether}(inputCommp, wasmCommp, badW, wasmW);
    }

    function test_postJob_rejectsCommpMismatch() public {
        // Witness points to a valid piece, but the CommP doesn't match.
        IJobRegistry.PdpWitness memory inputW = IJobRegistry.PdpWitness(100, 1);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        vm.expectRevert("commp does not match PDP piece");
        // Pass wrong inputCommp (0x99) but valid witness for piece with digest 0x1
        registry.postJob{value: 1 ether}(bytes32(uint256(0x99)), wasmCommp, inputW, wasmW);
    }

    function test_submitProof() public {
        IJobRegistry.PdpWitness memory inputW = IJobRegistry.PdpWitness(100, 1);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp, inputW, wasmW);

        // Register output piece in PDP.
        bytes32 outputCommp = bytes32(uint256(0x3));
        mockPDP.setPiece(300, 10, outputCommp);
        IJobRegistry.PdpWitness memory outputW = IJobRegistry.PdpWitness(300, 10);

        // Build journal: inputCommp || wasmCommp || outputCommp
        bytes memory journal = abi.encodePacked(inputCommp, wasmCommp, outputCommp);

        uint256 workerBalanceBefore = worker.balance;

        vm.prank(worker);
        registry.submitProof(jobId, hex"", journal, outputW);

        IJobRegistry.Job memory job = registry.getJob(jobId);
        assertEq(uint8(job.status), uint8(IJobRegistry.JobStatus.Completed));
        assertEq(job.outputCommp, outputCommp);
        assertEq(job.worker, worker);
        assertEq(worker.balance, workerBalanceBefore + 1 ether);
    }

    function test_submitProof_rejectsWithoutOutputInPDP() public {
        IJobRegistry.PdpWitness memory inputW = IJobRegistry.PdpWitness(100, 1);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp, inputW, wasmW);

        bytes32 outputCommp = bytes32(uint256(0x3));
        // Output witness points to nonexistent piece — should reject.
        IJobRegistry.PdpWitness memory badOutputW = IJobRegistry.PdpWitness(999, 99);

        bytes memory journal = abi.encodePacked(inputCommp, wasmCommp, outputCommp);

        vm.prank(worker);
        vm.expectRevert("piece not live in PDP");
        registry.submitProof(jobId, hex"", journal, badOutputW);
    }

    function test_submitProof_rejectsCompletedJob() public {
        IJobRegistry.PdpWitness memory inputW = IJobRegistry.PdpWitness(100, 1);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp, inputW, wasmW);

        bytes32 outputCommp = bytes32(uint256(0x3));
        mockPDP.setPiece(300, 10, outputCommp);
        IJobRegistry.PdpWitness memory outputW = IJobRegistry.PdpWitness(300, 10);

        bytes memory journal = abi.encodePacked(inputCommp, wasmCommp, outputCommp);

        vm.prank(worker);
        registry.submitProof(jobId, hex"", journal, outputW);

        vm.prank(worker);
        vm.expectRevert("job not open");
        registry.submitProof(jobId, hex"", journal, outputW);
    }

    function test_submitProof_rejectsCommpMismatch() public {
        IJobRegistry.PdpWitness memory inputW = IJobRegistry.PdpWitness(100, 1);
        IJobRegistry.PdpWitness memory wasmW = IJobRegistry.PdpWitness(200, 5);

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp, inputW, wasmW);

        bytes memory journal = abi.encodePacked(bytes32(uint256(0xFF)), wasmCommp, bytes32(0));

        IJobRegistry.PdpWitness memory outputW = IJobRegistry.PdpWitness(0, 0);

        vm.prank(worker);
        vm.expectRevert("input commp mismatch");
        registry.submitProof(jobId, hex"", journal, outputW);
    }
}
