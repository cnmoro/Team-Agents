import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  buildPage,
  decodeCompoundCursor,
  decodeIdCursor,
  encodeCompoundCursor,
  encodeIdCursor,
} from './pagination.js';
import { HttpError } from './errors.js';

describe('pagination cursors', () => {
  it('round-trips an id cursor', () => {
    const id = new Types.ObjectId();
    expect(String(decodeIdCursor(encodeIdCursor(id)))).toBe(String(id));
  });

  it('round-trips a compound cursor', () => {
    const id = new Types.ObjectId();
    const decoded = decodeCompoundCursor(encodeCompoundCursor('ada lovelace', id));
    expect(decoded.sortValue).toBe('ada lovelace');
    expect(String(decoded.id)).toBe(String(id));
  });

  it('is opaque to the client', () => {
    const id = new Types.ObjectId();
    const cursor = encodeIdCursor(id);
    // Base64url, so nothing about the underlying value leaks or invites tampering.
    expect(cursor).not.toContain(String(id));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor that is not a valid id', () => {
    const bogus = Buffer.from('not-an-object-id', 'utf8').toString('base64url');
    expect(() => decodeIdCursor(bogus)).toThrow(HttpError);
  });

  it('rejects a compound cursor with no separator', () => {
    const bogus = Buffer.from('noseparator', 'utf8').toString('base64url');
    expect(() => decodeCompoundCursor(bogus)).toThrow(HttpError);
  });
});

describe('buildPage', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ id: index }));

  it('trims the over-fetched row and reports more pages', () => {
    // Callers fetch limit + 1 so `hasMore` never needs a count query.
    const page = buildPage(rows, 5, (row) => row.id, (row) => `c${row.id}`);
    expect(page.items).toEqual([0, 1, 2, 3, 4]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('c4');
  });

  it('reports the end of the list', () => {
    const page = buildPage(rows.slice(0, 3), 5, (row) => row.id, (row) => `c${row.id}`);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = buildPage([], 5, (row: { id: number }) => row.id, (row) => `c${row.id}`);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
