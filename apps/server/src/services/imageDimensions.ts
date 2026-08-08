/**
 * Minimal, bounded image dimension reader.
 *
 * Deliberately hand-written rather than delegated to a general image library:
 * this runs on untrusted uploads inside the request path, and a parser that
 * loops on malformed input would stall the whole event loop. Only the formats
 * the chat renders inline are supported, every read is bounds-checked, and the
 * JPEG segment walk is iteration-capped. Anything unrecognized returns null,
 * which simply means the image renders without a known aspect ratio.
 */

export interface Dimensions {
  width: number;
  height: number;
}

const MAX_JPEG_SEGMENTS = 512;

export function readImageDimensions(buffer: Buffer): Dimensions | null {
  if (buffer.length < 16) return null;
  return (
    readPng(buffer) ??
    readGif(buffer) ??
    readWebp(buffer) ??
    readBmp(buffer) ??
    readJpeg(buffer)
  );
}

function readPng(buffer: Buffer): Dimensions | null {
  // \x89PNG\r\n\x1a\n then an IHDR chunk whose width/height are big-endian u32.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24) return null;
  for (let i = 0; i < signature.length; i++) if (buffer[i] !== signature[i]) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return sane(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function readGif(buffer: Buffer): Dimensions | null {
  if (buffer.length < 10) return null;
  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  return sane(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function readBmp(buffer: Buffer): Dimensions | null {
  if (buffer.length < 26) return null;
  if (buffer.toString('ascii', 0, 2) !== 'BM') return null;
  // Height is signed: a negative value means a top-down bitmap.
  return sane(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)));
}

function readWebp(buffer: Buffer): Dimensions | null {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return null;

  const format = buffer.toString('ascii', 12, 16);

  if (format === 'VP8 ') {
    // Lossy: 14-byte frame header, dimensions as 14-bit values.
    if (buffer.length < 30) return null;
    return sane(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }

  if (format === 'VP8L') {
    // Lossless: 14 bits width-1 then 14 bits height-1, packed little-endian.
    if (buffer.length < 25) return null;
    const bits = buffer.readUInt32LE(21);
    return sane((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }

  if (format === 'VP8X') {
    // Extended: 24-bit little-endian canvas size minus one.
    if (buffer.length < 30) return null;
    const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
    const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
    return sane(width, height);
  }

  return null;
}

function readJpeg(buffer: Buffer): Dimensions | null {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  for (let segment = 0; segment < MAX_JPEG_SEGMENTS; segment++) {
    // Markers may be preceded by any number of 0xFF fill bytes.
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset + 1 >= buffer.length) return null;

    const marker = buffer[offset]!;
    offset++;

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // Start of scan: entropy-coded data follows, so no header remains to read.
    if (marker === 0xda || marker === 0xd9) return null;

    if (offset + 1 >= buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    // A length below 2 would not advance the cursor and could loop forever.
    if (length < 2) return null;

    // SOF0-SOF15, excluding the non-frame markers DHT (c4), JPG (c8), DAC (cc).
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      if (offset + 7 >= buffer.length) return null;
      return sane(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }

    offset += length;
    if (offset >= buffer.length) return null;
  }
  return null;
}

/** Rejects absurd or zero dimensions rather than storing nonsense. */
function sane(width: number, height: number): Dimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > 100_000 || height > 100_000) return null;
  return { width, height };
}
