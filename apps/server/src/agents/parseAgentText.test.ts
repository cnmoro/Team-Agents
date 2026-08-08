import { describe, expect, it } from 'vitest';
import { parseAgentText } from './runtime.js';

/**
 * Agent output arrives as markdown. Splitting fenced blocks out of it is what
 * turns a wall of backticks into real, copyable, highlighted code blocks in the
 * chat.
 */
describe('parseAgentText', () => {
  it('returns plain text unchanged', () => {
    expect(parseAgentText('Just a sentence.')).toEqual([
      { type: 'text', text: 'Just a sentence.' },
    ]);
  });

  it('splits a fenced code block out of surrounding prose', () => {
    const blocks = parseAgentText(
      'Here is the fix:\n```python\nprint("hi")\n```\nLet me know if that works.',
    );
    expect(blocks).toEqual([
      { type: 'text', text: 'Here is the fix:' },
      { type: 'code', language: 'python', code: 'print("hi")' },
      { type: 'text', text: 'Let me know if that works.' },
    ]);
  });

  it('handles several code blocks', () => {
    const blocks = parseAgentText('```sql\nSELECT 1;\n```\nand\n```bash\nls -la\n```');
    expect(blocks.filter((block) => block.type === 'code')).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'code', language: 'sql', code: 'SELECT 1;' });
    expect(blocks[2]).toEqual({ type: 'code', language: 'bash', code: 'ls -la' });
  });

  it('defaults an unlabelled fence to plaintext', () => {
    const blocks = parseAgentText('```\nno language here\n```');
    expect(blocks).toEqual([{ type: 'code', language: 'plaintext', code: 'no language here' }]);
  });

  it('lowercases the language tag', () => {
    const blocks = parseAgentText('```SQL\nSELECT 1;\n```');
    expect(blocks[0]).toMatchObject({ language: 'sql' });
  });

  it('preserves indentation inside a block', () => {
    const blocks = parseAgentText('```ts\nif (x) {\n  doThing();\n}\n```');
    expect(blocks[0]).toMatchObject({ code: 'if (x) {\n  doThing();\n}' });
  });

  it('ignores an empty code block', () => {
    const blocks = parseAgentText('before\n```js\n\n```\nafter');
    expect(blocks.every((block) => block.type === 'text')).toBe(true);
  });

  it('leaves an unterminated fence as text rather than swallowing the message', () => {
    const text = 'starting\n```js\nconst x = 1;';
    expect(parseAgentText(text)).toEqual([{ type: 'text', text }]);
  });

  it('never returns an empty block list', () => {
    expect(parseAgentText('')).toHaveLength(1);
  });
});
