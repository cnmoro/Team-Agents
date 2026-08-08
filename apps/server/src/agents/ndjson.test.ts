import { describe, expect, it, vi } from 'vitest';
import { NdjsonReader, ndjsonLine, stripAnsi, summarize } from './ndjson.js';

describe('NdjsonReader', () => {
  it('parses whole lines', () => {
    const values: unknown[] = [];
    const reader = new NdjsonReader((value) => values.push(value));
    reader.push('{"a":1}\n{"b":2}\n');
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reassembles a value split across chunks', () => {
    // Harness stdout arrives in arbitrary chunks; a JSON object routinely
    // straddles the boundary.
    const values: unknown[] = [];
    const reader = new NdjsonReader((value) => values.push(value));
    reader.push('{"type":"assis');
    reader.push('tant","text":"hel');
    reader.push('lo"}\n');
    expect(values).toEqual([{ type: 'assistant', text: 'hello' }]);
  });

  it('reports non-JSON lines instead of dropping them', () => {
    const values: unknown[] = [];
    const junk: string[] = [];
    const reader = new NdjsonReader(
      (value) => values.push(value),
      (line) => junk.push(line),
    );
    reader.push('ERROR: something happened on stderr\n{"ok":true}\n');
    expect(values).toEqual([{ ok: true }]);
    expect(junk).toEqual(['ERROR: something happened on stderr']);
  });

  it('reports malformed JSON as unparsable rather than throwing', () => {
    const junk: string[] = [];
    const reader = new NdjsonReader(
      () => {},
      (line) => junk.push(line),
    );
    expect(() => reader.push('{"broken":\n')).not.toThrow();
    expect(junk).toEqual(['{"broken":']);
  });

  it('flushes a trailing line without a newline on end()', () => {
    const values: unknown[] = [];
    const reader = new NdjsonReader((value) => values.push(value));
    reader.push('{"last":true}');
    expect(values).toEqual([]);
    reader.end();
    expect(values).toEqual([{ last: true }]);
  });

  it('ignores blank lines', () => {
    const onValue = vi.fn();
    const reader = new NdjsonReader(onValue);
    reader.push('\n\n   \n');
    expect(onValue).not.toHaveBeenCalled();
  });

  it('drops a runaway buffer rather than growing without bound', () => {
    const reader = new NdjsonReader(() => {});
    // 40 MB with no newline: a broken producer must not exhaust memory.
    expect(() => reader.push('x'.repeat(40 * 1024 * 1024))).not.toThrow();
    const values: unknown[] = [];
    const next = new NdjsonReader((value) => values.push(value));
    next.push('{"still":"working"}\n');
    expect(values).toEqual([{ still: 'working' }]);
  });
});

describe('ndjsonLine', () => {
  it('serializes with a trailing newline', () => {
    expect(ndjsonLine({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe('summarize', () => {
  it('collapses whitespace', () => {
    expect(summarize('hello   \n  world')).toBe('hello world');
  });

  it('truncates long text with an ellipsis', () => {
    const result = summarize('a'.repeat(300), 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('stripAnsi', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  it('removes colour codes', () => {
    expect(stripAnsi(`${ESC}[32mgreen${ESC}[0m text`)).toBe('green text');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}after`)).toBe('after');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('nothing to strip')).toBe('nothing to strip');
  });
});
