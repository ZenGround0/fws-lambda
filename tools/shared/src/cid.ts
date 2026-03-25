// CommP <-> CID conversion for Filecoin piece commitments.
//
// Supports two CID formats:
//
// CommPv1 (legacy): CIDv1 | fil-commitment-unsealed (0xf101) | sha2-256-trunc254-padded (0x1012) | 32-byte digest
// CommPv2 (FRC-0069): CIDv1 | raw (0x55) | fr32-sha2-256-trunc254-padded-binary-tree (0x9120) | multihash-length | uvarint-padding | uint8-height | 32-byte digest

const FIL_COMMITMENT_UNSEALED = 0xf101n
const SHA2_256_TRUNC254_PADDED = 0x1012n
const RAW_CODEC = 0x55n
const FR32_SHA2_256_TRUNC254_PADDED_BINARY_TREE = 0x1011n

/** Extract the raw 32-byte CommP digest from either a CommPv1 or CommPv2 CID string. */
export function cidToCommp(cid: string): Uint8Array {
  if (!cid.startsWith("b")) throw new Error("expected multibase base32lower CID (b prefix)")

  const bytes = base32Decode(cid.slice(1))
  let offset = 0

  // Version
  const [version, vLen] = decodeVarint(bytes, offset)
  offset += vLen
  if (version !== 1n) throw new Error(`expected CIDv1, got v${version}`)

  // Multicodec
  const [codec, cLen] = decodeVarint(bytes, offset)
  offset += cLen

  if (codec === FIL_COMMITMENT_UNSEALED) {
    // CommPv1: multicodec 0xf101, multihash 0x1012, 32-byte digest
    const [mhCode, mhLen] = decodeVarint(bytes, offset)
    offset += mhLen
    if (mhCode !== SHA2_256_TRUNC254_PADDED) {
      throw new Error(`expected sha2-256-trunc254-padded (0x1012), got 0x${mhCode.toString(16)}`)
    }
    const [digestLen, dlLen] = decodeVarint(bytes, offset)
    offset += dlLen
    if (digestLen !== 32n) throw new Error(`expected 32-byte digest, got ${digestLen}`)
    return bytes.slice(offset, offset + 32)

  } else if (codec === RAW_CODEC) {
    // CommPv2 (FRC-0069): multicodec 0x55, multihash 0x9120, then mh-length, padding, height, digest
    const [mhCode, mhLen] = decodeVarint(bytes, offset)
    offset += mhLen
    if (mhCode !== FR32_SHA2_256_TRUNC254_PADDED_BINARY_TREE) {
      throw new Error(`expected fr32-sha2-256-trunc254-padded-binary-tree (0x9120), got 0x${mhCode.toString(16)}`)
    }
    // Multihash length (total bytes of: padding + height + digest)
    const [_mhLength, mhLenLen] = decodeVarint(bytes, offset)
    offset += mhLenLen
    // Padding (uvarint)
    const [_padding, padLen] = decodeVarint(bytes, offset)
    offset += padLen
    // Height (1 byte)
    offset += 1
    // Last 32 bytes are the digest
    return bytes.slice(offset, offset + 32)

  } else {
    throw new Error(`unsupported CID multicodec: 0x${codec.toString(16)}`)
  }
}

/** Encode a raw 32-byte CommP as a CommPv1 CID string (for compatibility). */
export function commpToCid(commp: Uint8Array): string {
  if (commp.length !== 32) throw new Error("commp must be 32 bytes")

  const buf: number[] = []
  // CIDv1 version
  buf.push(0x01)
  // Multicodec: fil-commitment-unsealed = 0xf101
  encodeVarint(buf, FIL_COMMITMENT_UNSEALED)
  // Multihash code: sha2-256-trunc254-padded = 0x1012
  encodeVarint(buf, SHA2_256_TRUNC254_PADDED)
  // Multihash digest length
  buf.push(0x20) // 32
  // Digest
  for (const b of commp) buf.push(b)

  return "b" + base32Encode(new Uint8Array(buf))
}

// --- varint encoding/decoding ---

function encodeVarint(buf: number[], value: bigint): void {
  let v = value
  while (v >= 0x80n) {
    buf.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  buf.push(Number(v))
}

function decodeVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let value = 0n
  let shift = 0n
  let i = offset
  while (i < buf.length) {
    const b = buf[i]
    value |= BigInt(b & 0x7f) << shift
    i++
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return [value, i - offset]
}

// --- RFC 4648 base32 lowercase (no padding) ---

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

export function base32Encode(data: Uint8Array): string {
  let bits = 0n
  let numBits = 0
  let result = ""
  for (const byte of data) {
    bits = (bits << 8n) | BigInt(byte)
    numBits += 8
    while (numBits >= 5) {
      numBits -= 5
      result += B32_ALPHABET[Number((bits >> BigInt(numBits)) & 0x1fn)]
    }
  }
  if (numBits > 0) {
    result += B32_ALPHABET[Number((bits << BigInt(5 - numBits)) & 0x1fn)]
  }
  return result
}

const B32_DECODE: Record<string, number> = {}
for (let i = 0; i < B32_ALPHABET.length; i++) {
  B32_DECODE[B32_ALPHABET[i]] = i
}

function base32Decode(str: string): Uint8Array {
  let bits = 0n
  let numBits = 0
  const result: number[] = []
  for (const ch of str) {
    const val = B32_DECODE[ch]
    if (val === undefined) throw new Error(`invalid base32 character: ${ch}`)
    bits = (bits << 5n) | BigInt(val)
    numBits += 5
    while (numBits >= 8) {
      numBits -= 8
      result.push(Number((bits >> BigInt(numBits)) & 0xffn))
    }
  }
  return new Uint8Array(result)
}
