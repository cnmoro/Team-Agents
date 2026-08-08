import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import type { CodeBlock } from '@teamagents/shared';
import { highlightCode } from '../../lib/highlight.js';
import { useThemeMode } from '../../App.js';

/**
 * A Teams-style code block: language label, copy button, syntax highlighting.
 *
 * Highlighting is asynchronous (Shiki loads grammars on demand), so the raw
 * text renders immediately and is replaced once highlighting resolves. That
 * keeps the message readable even if highlighting fails or is still loading.
 */
export function CodeBlockView({ block }: { block: CodeBlock }): ReactNode {
  const { mode } = useThemeMode();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void highlightCode(block.code, block.language, mode).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [block.code, block.language, mode]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the code is still selectable by hand.
    }
  };

  return (
    <div className="ta-code">
      <div className="ta-code-header">
        <HStack gap={2} vAlign="center">
          <Text type="supporting" color="secondary">
            {block.filename ?? block.language}
          </Text>
          {block.filename ? (
            <Text type="supporting" color="disabled">
              {block.language}
            </Text>
          ) : null}
        </HStack>
        <Button
          label={copied ? 'Copied' : 'Copy'}
          size="sm"
          variant="ghost"
          icon={<Icon icon={copied ? 'check' : 'copy'} />}
          onClick={() => void copy()}
        />
      </div>
      <div className="ta-code-body">
        {html ? (
          // Shiki output is generated from the code text by a trusted local
          // library, not from user-supplied markup.
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{block.code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
