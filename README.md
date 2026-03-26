FWS Lambda

Simple verifiable compute over verifiable data.

# What is this

This is web3's answer to the beloved aws lambda product. The jobs are specified as wasm.  Proving and verification is done with risc0 zkvm.  Input output and code are all specified with cids and verified to be stored in the FWSS/PDP verifiable storage system before and after the computation.

Jobs are listed publically on the filecoin blockchain. The job client posts a fee that will be paid out to the compute provider upon verifiable completion.  Jobs are only completed after the computer provider posts a snark proving the computation correct and posts the output of the job within the fwss service so that it is publically availabe for retrieval.

# How does it work

Client and worker software talk to the job registry contract on the fvm.  They upload and download data from fwss using the synapse sdk.  The risc0 host program is launched by the worker software and hashes wasm program and input data to validate that they match the hashes stored on pdp.  The output is also hashed and validated to match what the worker stores on pdp at the end of computing.  Since all of this is validated by the risc0 vm the resulting proof validates data integrity along with compute correctness.  The worker posts a proof to the chain which is verified through a call to a deployed risc0 verifier contract.  risc0's final proof is just groth16 over the standard BN254 curve so fevm precompiles can readily process verification on chain.

# How far along is this project

This is a simple hackathon prototype.  The job interface is minimal as is the proving and client software UX.  We've got contracts deployed on filecoin calibration testnet.  We've validated that proving works in ~10 minutes on ~10kb of input code / data when running on a modern 32 core CPU.  Porting to GPU would at least 10x proving speed.

There are lots of directions to take this.  If you're interested in working on this tag @zenground0 on filecoin slack. 

# Some fun ideas for further work

## Trigger this system as part of other protocols

Blockchain protocols often need lambda like gadgets for verifying something offchain.  An obvious generic application is a rollup chain processing general transactions.  Such a system could be made with high data retention guarantees by adding data dao primitives to the underlying storage deals governing the pdp cids.

Merkle tree translations is an obvious and useful primitives.  For example allowing filecoin SPs to commit to storage deals over data stored on hashed with and retrieved from ipfs.

A trustless data wallet management system could use lambdas to provably combine and modify merkle dags such that a user's datawallet is only ever a single hash.  The user updates their wallet abstractly (add this file, delete this file) and gets a guarantee that their new wallet hash contains everything without needing to retrieve any data.

Efficiently proving inclusion of pieces within sectors or PDP pieces is a useful primitive for repair protocols.

## GPU integration

Enabling GPU proving should be a minor configuration adjustment of the worker tool and the host binary.  Even on modest hardware it should improve speed significantly

## Bonsai integration

Proving tasks can be offloaded to the bonsai network with a simple integration.  Output and proof just need to be ferried back to fevm.


