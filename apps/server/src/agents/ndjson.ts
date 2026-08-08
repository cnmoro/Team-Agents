/**
 * Newline-delimited JSON framing for harness stdio.
 *
 * All three harnesses emit one JSON object per line, but they interleave it
 * with plain-text diagnostics and can split a line across chunk boundaries, so
 * the reader buffers, tolerates non-JSON lines, and never throws on garbage.
 */
export class NdjsonReader {
  private buffer = '';

  constructor(
    private readonly onValue: (value: unknown, raw: string) => void,
    private readonly onUnparsable?: (line: string) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
    // A single JSON object larger than this is a runaway; dropping the buffer
    // is better than growing without bound.
    if (this.buffer.length > 32 * 1024 * 1024) this.buffer = '';
  }

  /** Flushes a trailing line that never received its newline. */
  end(): void {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.startsWith('{') && !line.startsWith('[')) {
      this.onUnparsable?.(line);
      return;
    }
    try {
      this.onValue(JSON.parse(line), line);
    } catch {
      this.onUnparsable?.(line);
    }
  }
}

/** Serializes a value as one NDJSON frame. */
export function ndjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Truncates long text for a one-line trace summary. */
export function summarize(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Removes ANSI escape sequences, which harnesses emit even with NO_COLOR. */
const ANSI_PATTERN = new RegExp(
  // CSI sequences (colours, cursor moves) and OSC sequences (window titles).
  "\\u001B\\[[0-9;?]*[A-Za-z]|\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
