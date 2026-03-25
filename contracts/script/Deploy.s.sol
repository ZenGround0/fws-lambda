// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {ControlID, RiscZeroGroth16Verifier} from "risc0/groth16/RiscZeroGroth16Verifier.sol";
import {IRiscZeroVerifier} from "risc0/IRiscZeroVerifier.sol";
import {JobRegistry, IPDPVerifierRead} from "../src/JobRegistry.sol";

contract Deploy is Script {
    function run() external {
        // PDP Verifier proxy on Calibration testnet.
        address pdpVerifierAddr = vm.envOr(
            "PDP_VERIFIER_ADDRESS",
            address(0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C)
        );

        // Guest image ID — the hash of the zkVM guest ELF binary.
        // Use a placeholder for now; update after building the guest.
        bytes32 imageId = vm.envOr(
            "IMAGE_ID",
            bytes32(uint256(0))
        );

        vm.startBroadcast();

        // Deploy the RISC Zero Groth16 verifier.
        RiscZeroGroth16Verifier risc0Verifier = new RiscZeroGroth16Verifier(
            ControlID.CONTROL_ROOT,
            ControlID.BN254_CONTROL_ID
        );
        console.log("RiscZeroGroth16Verifier deployed at:", address(risc0Verifier));

        // Deploy the JobRegistry.
        JobRegistry registry = new JobRegistry(
            IRiscZeroVerifier(address(risc0Verifier)),
            IPDPVerifierRead(pdpVerifierAddr),
            imageId
        );
        console.log("JobRegistry deployed at:", address(registry));
        console.log("PDP Verifier:", pdpVerifierAddr);
        console.log("Image ID:", vm.toString(imageId));

        vm.stopBroadcast();
    }
}
