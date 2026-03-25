// CommP <-> CID conversion for Filecoin piece commitments.
//
// CIDv1 format: version(1) + multicodec(fil-commitment-unsealed=0xf101)
//   + multihash(sha2-256-trunc254-padded=0x1012, length=32, digest)
// Encoded as multibase base32lower with "b" prefix.

const FIL_COMMITMENT_UNSEALED = 0xf101n
const SHA2_256_TRUNC254_PADDED = 0x1012n

/** Encode a raw 32-byte CommP as a Filecoin CIDv1 string. */
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

/** Decode a Filecoin piece commitment CID to raw 32-byte CommP. */
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
  if (codec !== FIL_COMMITMENT_UNSEALED) {
    throw new Error(`expected fil-commitment-unsealed (0xf101), got 0x${codec.toString(16)}`)
  }

  // Multihash code
  const [mhCode, mhLen] = decodeVarint(bytes, offset)
  offset += mhLen
  if (mhCode !== SHA2_256_TRUNC254_PADDED) {
    throw new Error(`expected sha2-256-trunc254-padded (0x1012), got 0x${mhCode.toString(16)}`)
  }

  // Digest length
  const [digestLen, dlLen] = decodeVarint(bytes, offset)
  offset += dlLen
  if (digestLen !== 32n) throw new Error(`expected 32-byte digest, got ${digestLen}`)

  return bytes.slice(offset, offset + 32)
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

function base32Encode(data: Uint8Array): string {
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
