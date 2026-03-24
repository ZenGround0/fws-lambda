// Adapted from https://github.com/aidan46/WASM-CommP/blob/main/src/hasher.rs
//
// SHA-256 truncated to 254 bits (sha2-256-trunc254-padded) as used
// by Filecoin for piece commitments. The two most significant bits of
// the last byte are zeroed so the result fits in a BLS12-381 scalar field element.

use rs_merkle::Hasher;
use sha2::{Digest, Sha256 as Sha2_256};

#[derive(Clone)]
pub struct Sha256;

impl Hasher for Sha256 {
    type Hash = [u8; 32];

    fn hash(data: &[u8]) -> Self::Hash {
        let mut hasher = Sha2_256::new();
        hasher.update(data);
        let mut h = [0u8; 32];
        h.copy_from_slice(hasher.finalize().as_ref());
        // Truncate to 254 bits: zero the two most significant bits of the last byte.
        h[31] &= 0b0011_1111;
        h
    }
}
