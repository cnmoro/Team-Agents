import { describe, expect, it } from 'vitest';
import { readImageDimensions } from './imageDimensions.js';

/** A 10x5 PNG, the smallest real file that exercises the IHDR path. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAFCAYAAABirU3bAAAAFElEQVR42mNk+M9QzzCKQTEIAgAmAgMBSKcvVwAAAABJRU5ErkJggg==',
  'base64',
);

/** A 1x1 GIF. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** A 1x1 JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

describe('readImageDimensions', () => {
  it('reads PNG dimensions', () => {
    expect(readImageDimensions(PNG)).toEqual({ width: 10, height: 5 });
  });

  it('reads GIF dimensions', () => {
    expect(readImageDimensions(GIF)).toEqual({ width: 1, height: 1 });
  });

  it('reads JPEG dimensions from the frame header', () => {
    expect(readImageDimensions(JPEG)).toEqual({ width: 1, height: 1 });
  });

  it('returns null for a non-image', () => {
    expect(readImageDimensions(Buffer.from('this is just text, not an image at all'))).toBeNull();
  });

  it('returns null for a truncated file rather than throwing', () => {
    expect(readImageDimensions(PNG.subarray(0, 12))).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0))).toBeNull();
  });

  it('terminates on a malformed JPEG instead of looping forever', () => {
    // A JPEG whose segment length is zero would not advance the cursor; the
    // parser must bail rather than spin, since this runs on untrusted uploads.
    const malformed = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x00]),
      Buffer.alloc(64),
    ]);
    const start = Date.now();
    expect(readImageDimensions(malformed)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('terminates on a JPEG made of endless fill bytes', () => {
    const fill = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200_000, 0xff)]);
    const start = Date.now();
    expect(readImageDimensions(fill)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('rejects absurd dimensions', () => {
    // A BMP claiming to be 2 billion pixels wide is corrupt or hostile.
    const bmp = Buffer.alloc(32);
    bmp.write('BM', 0, 'ascii');
    bmp.writeInt32LE(2_000_000_000, 18);
    bmp.writeInt32LE(10, 22);
    expect(readImageDimensions(bmp)).toBeNull();
  });

  it('reads a top-down BMP with a negative height', () => {
    const bmp = Buffer.alloc(32);
    bmp.write('BM', 0, 'ascii');
    bmp.writeInt32LE(64, 18);
    bmp.writeInt32LE(-32, 22);
    expect(readImageDimensions(bmp)).toEqual({ width: 64, height: 32 });
  });
});
