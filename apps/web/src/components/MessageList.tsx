import { Fragment, useMemo, type ReactNode } from 'react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
} from '@astryxdesign/core/Chat';
import type { AgentSession, MessageWithAuthor, UserPublic } from '@teamagents/shared';
import { MessageBlocks } from './blocks/MessageBlocks.js';
import { AgentCard } from './AgentCard.js';

/*
 * Astryx sizes a chat bubble from a percentage of the row, which suits a
 * text-only assistant transcript but leaves visible empty bubble beside a
 * picture or a short line. This has to be an inline style: the component's own
 * rules are unlayered StyleX atomics, so anything in our stylesheet's cascade
 * layer loses to them regardless of specificity, and `stylex.create` is a
 * compile-time API we cannot call from an app without the StyleX compiler.
 */
const HUG_CONTENT = { width: 'fit-content' } as const;

interface MessageListProps {
  messages: MessageWithAuthor[];
  agents: AgentSession[];
  membersById: Map<string, UserPublic>;
  currentUserId: string;
  isLoadingOlder: boolean;
  hasMore: boolean;
  onLoadOlder: () => Promise<void>;
  /** Null when selection mode is off. */
  selectedIds: Set<string> | null;
  onSelectMessage: (messageId: string, event: React.MouseEvent) => void;
  onDeleteMessage: (messageId: string) => void;
}

/**
 * Splits the conversation into ordinary messages and per-agent threads.
 *
 * Anything tied to an agent session — the agent's output, its questions, and the
 * prompts people sent it — belongs inside that agent's card rather than loose in
 * the conversation, where it would read as if the agent were another member.
 * System notices stay in the main flow even when they mention an agent, because
 * they are addressed to the room.
 */
function partitionMessages(messages: MessageWithAuthor[]): {
  flow: MessageWithAuthor[];
  threads: Map<string, MessageWithAuthor[]>;
} {
  const flow: MessageWithAuthor[] = [];
  const threads = new Map<string, MessageWithAuthor[]>();

  for (const message of messages) {
    const belongsToThread =
      message.agentSessionId !== null &&
      message.kind !== 'agent_session' &&
      message.kind !== 'system';

    if (!belongsToThread) {
      flow.push(message);
      continue;
    }
    const thread = threads.get(message.agentSessionId!) ?? [];
    thread.push(message);
    threads.set(message.agentSessionId!, thread);
  }

  return { flow, threads };
}

export function MessageList({
  messages,
  agents,
  membersById,
  currentUserId,
  isLoadingOlder,
  hasMore,
  onLoadOlder,
  selectedIds,
  onSelectMessage,
  onDeleteMessage,
}: MessageListProps): ReactNode {
  const { flow, threads } = useMemo(() => partitionMessages(messages), [messages]);

  if (messages.length === 0) {
    return (
      <ChatMessageList
        emptyState={
          <EmptyState
            title="No messages yet"
            description="Say hello, or type @Agent to put a coding agent to work."
          />
        }
      >
        {null}
      </ChatMessageList>
    );
  }

  let lastDate = '';

  return (
    <ChatMessageList
      density="balanced"
      // Astryx wires this to the scroll container and shows a spinner while the
      // returned promise is pending, which is exactly the scroll-up-to-load
      // behaviour this app needs.
      scrollToTopAction={hasMore ? onLoadOlder : undefined}
    >
      {isLoadingOlder ? (
        <HStack hAlign="center" padding={2}>
          <Spinner size="sm" label="Loading earlier messages" />
        </HStack>
      ) : null}

      {flow.map((message, index) => {
        const previous = flow[index - 1];
        const dayLabel = formatDay(message.createdAt);
        const showDay = dayLabel !== lastDate;
        if (showDay) lastDate = dayLabel;

        return (
          <Fragment key={message.id}>
            {showDay ? (
              <ChatSystemMessage variant="divider">{dayLabel}</ChatSystemMessage>
            ) : null}
            <MessageRow
              message={message}
              previous={showDay ? undefined : previous}
              agents={agents}
              threads={threads}
              membersById={membersById}
              currentUserId={currentUserId}
              isSelectable={selectedIds !== null}
              isSelected={selectedIds?.has(message.id) ?? false}
              onSelect={onSelectMessage}
              onDelete={onDeleteMessage}
            />
          </Fragment>
        );
      })}
    </ChatMessageList>
  );
}

interface MessageRowProps {
  message: MessageWithAuthor;
  previous: MessageWithAuthor | undefined;
  agents: AgentSession[];
  threads: Map<string, MessageWithAuthor[]>;
  membersById: Map<string, UserPublic>;
  currentUserId: string;
  isSelectable: boolean;
  isSelected: boolean;
  onSelect: (messageId: string, event: React.MouseEvent) => void;
  onDelete: (messageId: string) => void;
}

function MessageRow({
  message,
  previous,
  agents,
  threads,
  membersById,
  currentUserId,
  isSelectable,
  isSelected,
  onSelect,
  onDelete,
}: MessageRowProps): ReactNode {
  const isMine = message.author.kind === 'user' && message.author.userId === currentUserId;
  const isMentioned = message.mentions.includes(currentUserId);

  const wrap = (children: ReactNode): ReactNode => (
    <div
      className="ta-message-row"
      data-selectable={isSelectable}
      data-selected={isSelected}
      data-mentioned={isMentioned && !isMine}
      data-message-id={message.id}
      onClick={isSelectable ? (event) => onSelect(message.id, event) : undefined}
      role={isSelectable ? 'button' : undefined}
      tabIndex={isSelectable ? 0 : undefined}
      aria-pressed={isSelectable ? isSelected : undefined}
      onKeyDown={
        isSelectable
          ? (event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                onSelect(message.id, event as unknown as React.MouseEvent);
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );

  if (message.kind === 'system') {
    return wrap(
      <ChatSystemMessage>
        <MessageBlocks
          blocks={message.blocks}
          membersById={membersById}
          currentUserId={currentUserId}
        />
      </ChatSystemMessage>,
    );
  }

  if (message.kind === 'agent_session') {
    const session = agents.find((candidate) => candidate.id === message.agentSessionId);
    if (!session) return null;
    return wrap(
      <AgentCard
        session={session}
        messages={threads.get(session.id) ?? []}
        membersById={membersById}
        currentUserId={currentUserId}
      />,
    );
  }

  const authorName = message.authorUser?.displayName ?? 'Unknown';

  // Consecutive messages from the same author are grouped Slack-style: the
  // avatar and name appear once and the bubble corners tighten.
  const sameAuthorAsPrevious =
    previous !== undefined &&
    previous.kind === 'user' &&
    message.kind === 'user' &&
    authorKey(previous) === authorKey(message) &&
    withinGroupingWindow(previous.createdAt, message.createdAt);

  return wrap(
    <ChatMessage
      sender={isMine ? 'user' : 'assistant'}
      avatar={
        sameAuthorAsPrevious ? undefined : (
          <Avatar name={authorName} size="sm" tooltip={false} />
        )
      }
    >
      <ChatMessageBubble
        style={HUG_CONTENT}
        variant={isMine ? 'filled' : 'ghost'}
        group={sameAuthorAsPrevious ? 'middle' : 'first'}
        name={
          sameAuthorAsPrevious ? undefined : (
            <HStack gap={2} vAlign="center">
              <Text type="label" weight="semibold">
                {authorName}
              </Text>
              {/* Deleting is offered only on your own messages, and never while
                  selection mode has taken over click handling. */}
              {isMine && !isSelectable ? (
                <span className="ta-message-actions">
                  <DropdownMenu
                    hasChevron={false}
                    menuWidth={160}
                    button={{
                      label: 'Message actions',
                      icon: <Icon icon="moreHorizontal" />,
                      variant: 'ghost',
                      size: 'sm',
                      isIconOnly: true,
                    }}
                    items={[{ label: 'Delete message', onClick: () => onDelete(message.id) }]}
                  />
                </span>
              ) : null}
            </HStack>
          )
        }
        metadata={
          <ChatMessageMetadata timestamp={<span>{formatTime(message.createdAt)}</span>} />
        }
      >
        <VStack gap={2}>
          <MessageBlocks
            blocks={message.blocks}
            membersById={membersById}
            currentUserId={currentUserId}
          />
        </VStack>
      </ChatMessageBubble>
    </ChatMessage>,
  );
}

function authorKey(message: MessageWithAuthor): string {
  if (message.author.kind === 'user') return `u:${message.author.userId}`;
  if (message.author.kind === 'agent') return `a:${message.author.agentSessionId}`;
  return 'system';
}

/** Five minutes, the usual grouping window in chat clients. */
function withinGroupingWindow(previousIso: string, currentIso: string): boolean {
  return new Date(currentIso).getTime() - new Date(previousIso).getTime() < 5 * 60 * 1000;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
