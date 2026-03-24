// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {JobRegistry, IRiscZeroVerifier} from "../src/JobRegistry.sol";

contract Deploy is Script {
    function run() external {
        // These must be set as environment variables before deployment.
        address verifierAddr = vm.envAddress("VERIFIER_ADDRESS");
        bytes32 imageId = vm.envBytes32("IMAGE_ID");

        vm.startBroadcast();

        JobRegistry registry = new JobRegistry(
            IRiscZeroVerifier(verifierAddr),
            imageId
        );

        console.log("JobRegistry deployed at:", address(registry));

        vm.stopBroadcast();
    }
}
