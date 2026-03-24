// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test, console} from "forge-std/Test.sol";
import {JobRegistry, IRiscZeroVerifier, IJobRegistry} from "../src/JobRegistry.sol";

/// @dev Mock verifier that always accepts proofs (for testing only).
contract MockVerifier is IRiscZeroVerifier {
    function verify(bytes calldata, bytes32, bytes32) external pure {}
}

contract JobRegistryTest is Test {
    JobRegistry public registry;
    MockVerifier public mockVerifier;
    bytes32 public constant IMAGE_ID = bytes32(uint256(0xDEAD));

    address submitter = address(0x1);
    address worker = address(0x2);

    function setUp() public {
        mockVerifier = new MockVerifier();
        registry = new JobRegistry(mockVerifier, IMAGE_ID);
        vm.deal(submitter, 10 ether);
        vm.deal(worker, 1 ether);
    }

    function test_postJob() public {
        bytes32 inputCommp = bytes32(uint256(0x1));
        bytes32 wasmCommp = bytes32(uint256(0x2));

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp);

        IJobRegistry.Job memory job = registry.getJob(jobId);
        assertEq(job.inputCommp, inputCommp);
        assertEq(job.wasmCommp, wasmCommp);
        assertEq(job.submitter, submitter);
        assertEq(job.bounty, 1 ether);
        assertEq(uint8(job.status), uint8(IJobRegistry.JobStatus.Open));
    }

    function test_postJob_requiresBounty() public {
        vm.prank(submitter);
        vm.expectRevert("bounty required");
        registry.postJob(bytes32(0), bytes32(0));
    }

    function test_submitProof() public {
        bytes32 inputCommp = bytes32(uint256(0x1));
        bytes32 wasmCommp = bytes32(uint256(0x2));
        bytes32 outputCommp = bytes32(uint256(0x3));

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp);

        // Build journal: inputCommp || wasmCommp || outputCommp
        bytes memory journal = abi.encodePacked(inputCommp, wasmCommp, outputCommp);
        bytes memory seal = hex""; // mock verifier accepts anything

        uint256 workerBalanceBefore = worker.balance;

        vm.prank(worker);
        registry.submitProof(jobId, seal, journal);

        IJobRegistry.Job memory job = registry.getJob(jobId);
        assertEq(uint8(job.status), uint8(IJobRegistry.JobStatus.Completed));
        assertEq(job.outputCommp, outputCommp);
        assertEq(job.worker, worker);
        assertEq(worker.balance, workerBalanceBefore + 1 ether);
    }

    function test_submitProof_rejectsCompletedJob() public {
        bytes32 inputCommp = bytes32(uint256(0x1));
        bytes32 wasmCommp = bytes32(uint256(0x2));
        bytes32 outputCommp = bytes32(uint256(0x3));

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp);

        bytes memory journal = abi.encodePacked(inputCommp, wasmCommp, outputCommp);

        vm.prank(worker);
        registry.submitProof(jobId, hex"", journal);

        vm.prank(worker);
        vm.expectRevert("job not open");
        registry.submitProof(jobId, hex"", journal);
    }

    function test_submitProof_rejectsCommpMismatch() public {
        bytes32 inputCommp = bytes32(uint256(0x1));
        bytes32 wasmCommp = bytes32(uint256(0x2));

        vm.prank(submitter);
        uint256 jobId = registry.postJob{value: 1 ether}(inputCommp, wasmCommp);

        // Journal with wrong inputCommp
        bytes memory journal = abi.encodePacked(bytes32(uint256(0xFF)), wasmCommp, bytes32(0));

        vm.prank(worker);
        vm.expectRevert("input commp mismatch");
        registry.submitProof(jobId, hex"", journal);
    }
}
