import { useState, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import type { MessageBlock, UserPublic } from '@teamagents/shared';
import { api } from '../../lib/api.js';
import { CodeBlockView } from './CodeBlockView.js';
import { MarkdownText } from './MarkdownText.js';
import { PaperclipIcon } from '../icons.js';

interface MessageBlocksProps {
  blocks: MessageBlock[];
  /** Members of the conversation, used to render `@` mentions by name. */
  membersById: Map<string, UserPublic>;
  currentUserId: string;
}

/** The largest an inline image is allowed to render in a message bubble. */
const IMAGE_MAX_WIDTH = 420;
const IMAGE_MAX_HEIGHT = 320;

/**
 * Scales an image down to fit the inline preview box, preserving aspect ratio.
 *
 * The result is applied as real `width`/`height` attributes rather than left to
 * CSS. A bubble sizes itself to its content's *intrinsic* width, and a replaced
 * element contributes its natural size regardless of `max-width` — so a 1600px
 * screenshot would blow the bubble out to the width of the pane even though the
 * picture itself rendered at 420px.
 */
function displaySize(
  width: number | undefined,
  height: number | undefined,
): { width: number; height: number } | null {
  if (!width || !height) return null;
  const scale = Math.min(1, IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function MessageBlocks({
  blocks,
  membersById,
  currentUserId,
}: MessageBlocksProps): ReactNode {
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);

  return (
    <>
      <VStack gap={2}>
        {blocks.map((block, index) => {
          const key = `${block.type}-${index}`;
          if (block.type === 'text') {
            return (
              <MarkdownText
                key={key}
                text={block.text}
                membersById={membersById}
                currentUserId={currentUserId}
              />
            );
          }
          if (block.type === 'code') return <CodeBlockView key={key} block={block} />;
          if (block.type === 'image') {
            return (
              <ImageOrFallback
                key={key}
                block={block}
                onOpen={() => setLightbox({ url: api.fileUrl(block.fileId), alt: block.filename })}
              />
            );
          }
          return <FileCard key={key} block={block} />;
        })}
      </VStack>

      {lightbox ? (
        <button
          type="button"
          className="ta-lightbox"
          aria-label="Close image preview"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox.url} alt={lightbox.alt} />
        </button>
      ) : null}
    </>
  );
}

/**
 * Renders an `image` block as an actual `<img>`, but falls back to the same
 * download-card treatment as a `file` block if the browser can't decode it.
 *
 * This is reachable without anything malicious: `isImage` is decided
 * server-side purely from the upload's declared `Content-Type`, not by
 * sniffing the bytes, so a mislabeled upload (or an image format the
 * server's dimension reader doesn't recognize but the browser also can't
 * render) would otherwise leave a permanently broken `<img>` icon with no
 * filename, size, or way to retrieve the file at all.
 */
function ImageOrFallback({
  block,
  onOpen,
}: {
  block: Extract<MessageBlock, { type: 'image' }>;
  onOpen: () => void;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileCard block={{ ...block, type: 'file' }} />;

  const size = displaySize(block.width, block.height);
  return (
    <img
      className="ta-image"
      src={api.fileUrl(block.fileId)}
      alt={block.filename}
      width={size?.width}
      height={size?.height}
      loading="lazy"
      onClick={onOpen}
      onError={() => setFailed(true)}
    />
  );
}

function FileCard({ block }: { block: Extract<MessageBlock, { type: 'file' }> }): ReactNode {
  return (
    <Card padding={3} variant="muted" maxWidth={420}>
      <HStack gap={3} vAlign="center" hAlign="between">
        <HStack gap={2} vAlign="center">
          <Icon icon={PaperclipIcon} color="secondary" />
          <VStack gap={0}>
            <Text type="label" maxLines={1}>
              {block.filename}
            </Text>
            <Text type="supporting" color="secondary">
              {formatBytes(block.size)}
            </Text>
          </VStack>
        </HStack>
        <Button
          label="Download"
          size="sm"
          variant="secondary"
          onClick={() => window.open(api.fileUrl(block.fileId, true), '_blank', 'noopener')}
        />
      </HStack>
    </Card>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
