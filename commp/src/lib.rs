// CommP (piece commitment) computation for Filecoin.
// Adapted from https://github.com/aidan46/WASM-CommP
//
// Algorithm:
//   1. Zero-pad raw data to unpadded piece size (power-of-2 multiple of 127)
//   2. FR32-pad: insert 2 zero bits every 254 bits so each 32-byte chunk
//      is a valid BLS12-381 scalar field element
//   3. Build a binary Merkle tree over 32-byte leaves using SHA-256
//      truncated to 254 bits (sha2-256-trunc254-padded)
//   4. The root is the CommP

mod fr32_reader;
mod hasher;
mod zero_reader;

use std::io::{Cursor, Read};

use rs_merkle::MerkleTree;

pub use crate::hasher::Sha256;
use crate::fr32_reader::Fr32Reader;
use crate::zero_reader::ZeroPaddingReader;

/// Merkle tree node size in bytes.
pub const NODE_SIZE: usize = 32;

/// Padded piece size — always a power of 2 and a multiple of NODE_SIZE.
/// After FR32 padding, this is the total number of bytes in the piece.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaddedPieceSize(pub u64);

impl PaddedPieceSize {
    /// Compute the padded piece size for an arbitrary input size.
    ///
    /// 1. Account for FR32 expansion: every 127 bytes become 128 bytes
    /// 2. Round up to the next power of two
    pub fn from_arbitrary_size(size: u64) -> Self {
        let fr32_expanded = size + (size / 127);
        let padded = fr32_expanded.next_power_of_two();
        PaddedPieceSize(padded)
    }

    /// The corresponding unpadded size (before FR32 padding).
    /// Every 128 padded bytes correspond to 127 unpadded bytes.
    pub fn unpadded(&self) -> u64 {
        self.0 - (self.0 / 128)
    }
}

/// Compute the Filecoin piece commitment (CommP) for the given raw data.
/// Returns the 32-byte commitment (Merkle root).
pub fn calc_commp(data: &[u8]) -> [u8; 32] {
    let padded_piece_size = PaddedPieceSize::from_arbitrary_size(data.len() as u64);
    let unpadded_with_zeroes = padded_piece_size.unpadded();

    let buffered = Cursor::new(data);
    let zero_padded = ZeroPaddingReader::new(buffered, unpadded_with_zeroes);
    let mut fr32_reader = Fr32Reader::new(zero_padded);

    let num_leaves = (padded_piece_size.0 as usize).div_ceil(NODE_SIZE);

    let mut buffer = [0u8; NODE_SIZE];
    let leaves: Vec<[u8; 32]> = (0..num_leaves)
        .map(|_| {
            fr32_reader
                .read_exact(&mut buffer)
                .expect("failed to read fr32-padded data");
            buffer
        })
        .collect();

    let tree = MerkleTree::<Sha256>::from_leaves(&leaves);
    tree.root().expect("tree must have a root")
}

/// Convert a raw 32-byte CommP to a CIDv1 string using the Filecoin
/// piece commitment multicodec (0xf101) and sha2-256-trunc254-padded
/// multihash (0x1012).
pub fn commp_to_cid(commp: &[u8; 32]) -> String {
    // CIDv1: version(1) + multicodec(0xf101) + multihash(0x1012, 32, digest)
    // All encoded as unsigned varints.
    let mut cid_bytes = Vec::with_capacity(4 + 3 + 2 + 1 + 32);

    // Version 1
    cid_bytes.push(0x01);

    // Multicodec: fil-commitment-unsealed = 0xf101
    // varint encoding of 0xf101 = [0x81, 0xe2, 0x03]
    cid_bytes.extend_from_slice(&[0x81, 0xe2, 0x03]);

    // Multihash code: sha2-256-trunc254-padded = 0x1012
    // varint encoding of 0x1012 = [0x92, 0x20]
    cid_bytes.extend_from_slice(&[0x92, 0x20]);

    // Multihash digest length: 32
    cid_bytes.push(0x20);

    // Digest
    cid_bytes.extend_from_slice(commp);

    // Encode as base32lower with "b" prefix (multibase)
    let mut base32 = String::with_capacity(1 + cid_bytes.len() * 8 / 5 + 1);
    base32.push('b');
    base32.push_str(&base32_encode(&cid_bytes));
    base32
}

/// RFC 4648 base32 lowercase encoding (no padding).
fn base32_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut result = String::new();
    let mut bits: u64 = 0;
    let mut num_bits: u32 = 0;

    for &byte in data {
        bits = (bits << 8) | byte as u64;
        num_bits += 8;
        while num_bits >= 5 {
            num_bits -= 5;
            let idx = ((bits >> num_bits) & 0x1f) as usize;
            result.push(ALPHABET[idx] as char);
        }
    }
    if num_bits > 0 {
        let idx = ((bits << (5 - num_bits)) & 0x1f) as usize;
        result.push(ALPHABET[idx] as char);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_padded_piece_size_from_arbitrary() {
        // 127 bytes of data -> 128 bytes after FR32 -> already power of 2
        assert_eq!(PaddedPieceSize::from_arbitrary_size(127).0, 128);
        // 1 byte -> rounds up
        let pps = PaddedPieceSize::from_arbitrary_size(1);
        assert!(pps.0.is_power_of_two());
    }

    #[test]
    fn test_commp_deterministic() {
        let data = b"hello filecoin";
        let c1 = calc_commp(data);
        let c2 = calc_commp(data);
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_commp_different_data() {
        let c1 = calc_commp(b"hello");
        let c2 = calc_commp(b"world");
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_commp_top_bits_zeroed() {
        let c = calc_commp(b"test data for commp verification");
        // The two most significant bits of the last byte must be zero
        assert_eq!(c[31] & 0b1100_0000, 0);
    }

    // Test vectors from https://github.com/filecoin-project/go-fil-commp-hashhash/tree/master/testdata
    // Format: (input_size, expected_padded_piece_size, expected_cid)

    /// Generate zero-filled data of a given size.
    fn zero_data(size: usize) -> Vec<u8> {
        vec![0u8; size]
    }

    /// Generate 0xCC-filled data of a given size.
    fn cc_data(size: usize) -> Vec<u8> {
        vec![0xCCu8; size]
    }

    // -- zero-filled test vectors (from zero.txt) --

    #[test]
    fn test_zero_96() {
        let cid = commp_to_cid(&calc_commp(&zero_data(96)));
        assert_eq!(cid, "baga6ea4seaqdomn3tgwgrh3g532zopskstnbrd2n3sxfqbze7rxt7vqn7veigmy");
    }

    #[test]
    fn test_zero_127() {
        let cid = commp_to_cid(&calc_commp(&zero_data(127)));
        assert_eq!(cid, "baga6ea4seaqdomn3tgwgrh3g532zopskstnbrd2n3sxfqbze7rxt7vqn7veigmy");
    }

    #[test]
    fn test_zero_256() {
        let cid = commp_to_cid(&calc_commp(&zero_data(256)));
        assert_eq!(cid, "baga6ea4seaqfpirydiugkk7up5v666wkm6n6jlw6lby2wxht5mwaqekerdfykjq");
    }

    #[test]
    fn test_zero_512() {
        let cid = commp_to_cid(&calc_commp(&zero_data(512)));
        assert_eq!(cid, "baga6ea4seaqb66wjlfkrbye6uqoemcyxmqylwmrm235uclwfpsyx3ge2imidoly");
    }

    #[test]
    fn test_zero_1024() {
        let cid = commp_to_cid(&calc_commp(&zero_data(1024)));
        assert_eq!(cid, "baga6ea4seaqpy7usqklokfx2vxuynmupslkeutzexe2uqurdg5vhtebhxqmpqmy");
    }

    // -- 0xCC-filled test vectors (from 0xCC.txt) --

    #[test]
    fn test_cc_96() {
        let cid = commp_to_cid(&calc_commp(&cc_data(96)));
        assert_eq!(cid, "baga6ea4seaqhwcjhi4krhl3ht6dewnwevkpxbepxy7p7onwgz65t52typbsysby");
    }

    #[test]
    fn test_cc_127() {
        let cid = commp_to_cid(&calc_commp(&cc_data(127)));
        assert_eq!(cid, "baga6ea4seaqmfldjtozgne6adk7eve2vdxte7vzlivae7nzsbrawobo546zkijq");
    }

    #[test]
    fn test_cc_254() {
        let cid = commp_to_cid(&calc_commp(&cc_data(254)));
        assert_eq!(cid, "baga6ea4seaqkixbzz75uys2pcjbrbdilgjhmum72qm4xphrwav2iyel5oat4aka");
    }

    #[test]
    fn test_cc_256() {
        let cid = commp_to_cid(&calc_commp(&cc_data(256)));
        assert_eq!(cid, "baga6ea4seaqi7c3dnwkqysqh4lpkz5jaxz2d2f5bvo3ttu2hnfmdewhcoji56na");
    }

    #[test]
    fn test_cc_512() {
        let cid = commp_to_cid(&calc_commp(&cc_data(512)));
        assert_eq!(cid, "baga6ea4seaqojaa522sjqms2wipasjbxnjgytunsgp52tgrfcofj73f7q7ou6hy");
    }

    #[test]
    fn test_cc_1024() {
        let cid = commp_to_cid(&calc_commp(&cc_data(1024)));
        assert_eq!(cid, "baga6ea4seaqdlpnhgsndrgjeu4p46hahlsr4lybg6du4d56ooppdpxhcofxeuoi");
    }

    // -- tests at boundary sizes where padded piece size changes --

    #[test]
    fn test_zero_126() {
        // Same padded size as 96 and 127 (128)
        let cid = commp_to_cid(&calc_commp(&zero_data(126)));
        assert_eq!(cid, "baga6ea4seaqdomn3tgwgrh3g532zopskstnbrd2n3sxfqbze7rxt7vqn7veigmy");
    }

    #[test]
    fn test_cc_508() {
        let cid = commp_to_cid(&calc_commp(&cc_data(508)));
        assert_eq!(cid, "baga6ea4seaqb6ckbupixkhwp7thgb52f4en222boppajkqk7gaomkpof3lh4cei");
    }

    #[test]
    fn test_cc_509() {
        // Crosses into next padded piece size (1024)
        let cid = commp_to_cid(&calc_commp(&cc_data(509)));
        assert_eq!(cid, "baga6ea4seaqdzbeaexq6gpbqh2tlnbz5mm5neap2kejsketkogzd6x2dx7dzkii");
    }
}
