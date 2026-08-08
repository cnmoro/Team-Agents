import { useMemo, type ReactNode } from 'react';
import { Markdown } from '@astryxdesign/core/Markdown';
import type { UserPublic } from '@teamagents/shared';
import { CodeBlockView } from './CodeBlockView.js';

/** Wire format the composer writes for a mention. */
const MENTION_PATTERN = /@\[([^\]]+)\]\((?:([0-9a-fA-F]{24})|(agent))\)/g;

/**
 * Invisible separator (U+2063). Used to fence a mention's id so markdown leaves
 * it alone: it has no markdown meaning, is not a word character, and never
 * appears in text someone typed.
 */
const SENTINEL = String.fromCharCode(0x2063);

const PLACEHOLDER_PATTERN = new RegExp(`@${SENTINEL}([0-9a-fA-F]{24}|agent)${SENTINEL}`, 'g');

/**
 * Message text, rendered as markdown.
 *
 * Astryx's Markdown handles the prose; the two things it cannot know about are
 * plugged in here:
 *
 * - **Mentions.** The composer stores them as `@[Display Name](userId)`, which
 *   is ordinary link syntax — and inline plugins run *after* parsing, so by the
 *   time one could match, markdown has already turned it into a link. The
 *   mention is therefore rewritten to a sentinel-fenced id before parsing and
 *   matched in that form, then resolved against the current member list so a
 *   renamed user still renders correctly.
 * - **Fenced code.** Routed to the same block used for standalone code blocks,
 *   so a fence typed inside a message gets the same highlighting and copy
 *   button as one built with the composer's code action.
 */
export function MarkdownText({
  text,
  membersById,
  currentUserId,
}: {
  text: string;
  membersById: Map<string, UserPublic>;
  currentUserId: string;
}): ReactNode {
  const { prepared, fallbackNames } = useMemo(() => {
    const names = new Map<string, string>();
    const rewritten = text.replace(MENTION_PATTERN, (_match, name: string, userId?: string, agent?: string) => {
      const id = userId ?? agent ?? '';
      names.set(id, name);
      return `@${SENTINEL}${id}${SENTINEL}`;
    });
    return { prepared: rewritten, fallbackNames: names };
  }, [text]);

  const components = useMemo(
    () => ({
      code: ({ code, language }: { code: string; language?: string }) => (
        <CodeBlockView block={{ type: 'code', language: language || 'plaintext', code }} />
      ),
      link: ({ href, children }: { href: string; children: ReactNode }) => (
        // Messages can carry links from anyone, so never leak the opener.
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      ),
    }),
    [],
  );

  const inlinePlugins = useMemo(
    () => [
      {
        pattern: PLACEHOLDER_PATTERN,
        render: (match: RegExpMatchArray, key: string) => {
          const id = match[1] ?? '';
          const label =
            id === 'agent'
              ? 'Agent'
              : (membersById.get(id)?.displayName ?? fallbackNames.get(id) ?? 'someone');
          return (
            <span key={key} className="ta-mention" data-self={id === currentUserId}>
              @{label}
            </span>
          );
        },
      },
    ],
    [membersById, currentUserId, fallbackNames],
  );

  return (
    <div className="ta-markdown">
      <Markdown components={components} inlinePlugins={inlinePlugins} density="compact">
        {prepared}
      </Markdown>
    </div>
  );
}
