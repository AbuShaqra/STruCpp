// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Portable byte-handling primitives.
 *
 * The CODESYS importer and a few binary helpers used to lean on
 * Node's `Buffer` class — `Buffer.from(...)`, `.equals(...)`,
 * `.toString("utf-8")`, `.readUInt32LE(...)`, `zlib.inflateRawSync`,
 * and friends.  None of those are available in a browser worker.
 *
 * `Uint8Array` is the portable substitute that works on both
 * platforms.  This module provides the small handful of operations
 * that map directly from the Buffer surface our parsers need.  Each
 * helper is a one-liner; the point is to keep the call sites
 * readable and free of `new TextDecoder().decode(...)` ceremony.
 */

const utf8Decoder = new TextDecoder("utf-8");
// The WHATWG "latin1" label is the windows-1252 decoder: 0x80 is U+20AC,
// not U+0080. The CODESYS V2.3 binary format stores POU declarations in it.
const latin1Decoder = new TextDecoder("latin1");
const utf8Encoder = new TextEncoder();

/** Compare two byte sequences for value-equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lower-case hex dump of a byte sequence (no separator, no prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** Decode a byte slice as UTF-8 text. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/**
 * Decode a byte slice as Windows-1252 text. Bytes 0x00–0x7F and 0xA0–0xFF map
 * to the same code points; 0x80–0x9F map to the CP1252 characters (0x80 is
 * U+20AC), and the five unassigned ones (0x81, 0x8D, 0x8F, 0x90, 0x9D) to the
 * C1 control of the same value, as the WHATWG "latin1" decoder does. Used by
 * the CODESYS V2.3 binary parser, where POU declarations are stored in this
 * single-byte encoding rather than UTF-8.
 */
export function bytesToLatin1(bytes: Uint8Array): string {
  return latin1Decoder.decode(bytes);
}

/**
 * Find the first occurrence of `needle` in `haystack` at or after
 * `offset`.  Returns the matching index, or -1 if not found.  The
 * built-in `Uint8Array#indexOf` only works on single bytes; this
 * helper handles multi-byte patterns the way Node's `Buffer#indexOf`
 * does.
 */
export function findSubArray(
  haystack: Uint8Array,
  needle: Uint8Array,
  offset = 0,
): number {
  if (needle.length === 0) return offset;
  const limit = haystack.length - needle.length;
  outer: for (let i = offset; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Encode a string as UTF-8 bytes. */
export function utf8ToBytes(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Read a little-endian unsigned 32-bit integer at `offset`. */
export function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(
    0,
    true,
  );
}

/** Read a little-endian unsigned 16-bit integer at `offset`. */
export function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(
    0,
    true,
  );
}

/**
 * Inflate a raw DEFLATE (zlib) stream.
 *
 * Uses the standard `DecompressionStream` API available in modern
 * browsers (Chrome 80+, Firefox 113+, Safari 16.4+) and Node 18+.
 * Both platforms run the same code path — no fork between worker
 * and Node CLI.
 */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const decompressionStream = new DecompressionStream("deflate-raw");
  const decompressedStream = new Blob([bytes])
    .stream()
    .pipeThrough(decompressionStream);
  const buffer = await new Response(decompressedStream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Code points of the CP1252 bytes 0x80–0x9F (an unassigned byte maps to itself). */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030,
  0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d,
  0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e,
  0x178,
];
const CP1252_FROM_CODE_POINT = new Map<number, number>(
  CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]),
);

/**
 * The Windows-1252 byte of a code point, or undefined when CP1252 has none.
 * STRING values are stored in this encoding, one byte per character.
 */
export function cp1252Byte(codePoint: number): number | undefined {
  if (codePoint < 0x80 || (codePoint >= 0xa0 && codePoint <= 0xff)) {
    return codePoint;
  }
  return CP1252_FROM_CODE_POINT.get(codePoint);
}

/** The code point a Windows-1252 byte stands for. */
export function cp1252CodePoint(byte: number): number {
  return byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : byte;
}
