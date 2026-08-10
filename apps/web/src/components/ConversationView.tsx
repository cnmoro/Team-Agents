import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { AvatarGroup, AvatarGroupOverflow } from '@astryxdesign/core/AvatarGroup';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { ChatLayout } from '@astryxdesign/core/Chat';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import type { MessageBlock } from '@teamagents/shared';
import { ApiError } from '../lib/api.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { useCurrentUser } from '../state/AuthContext.js';
import { useChat } from '../state/ChatContext.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { AgentStarterDialog } from './AgentStarterDialog.js';

export function ConversationView(): ReactNode {
  const me = useCurrentUser();
  const toast = useAppToast();
  const {
    activeConversation,
    activeConversationId,
    messages,
    agents,
    selectConversation,
    loadOlderMessages,
    sendMessage,
    deleteMessage,
    typingUsers,
    onlineUserIds,
    setTyping,
  } = useChat();

  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
  // Anchor for shift-click ranges, exactly like a file explorer.
  const anchorRef = useRef<string | null>(null);

  const membersById = useMemo(
    () => new Map((activeConversation?.members ?? []).map((member) => [member.id, member])),
    [activeConversation],
  );

  /**
   * Explorer-style selection: plain click selects one, Ctrl/Cmd toggles, and
   * Shift extends from the last anchor.
   */
  const handleSelectMessage = useCallback(
    (messageId: string, event: MouseEvent) => {
      const order = messages.items.map((message) => message.id);

      setSelectedIds((current) => {
        const next = new Set(current);

        if (event.shiftKey && anchorRef.current) {
          const from = order.indexOf(anchorRef.current);
          const to = order.indexOf(messageId);
          if (from !== -1 && to !== -1) {
            const [start, end] = from <= to ? [from, to] : [to, from];
            // A shift-click replaces the range rather than accumulating, which
            // is what makes repeated shift-clicks feel predictable.
            if (!event.ctrlKey && !event.metaKey) next.clear();
            for (let index = start; index <= end; index++) next.add(order[index]!);
            return next;
          }
        }

        if (event.ctrlKey || event.metaKey) {
          if (next.has(messageId)) next.delete(messageId);
          else next.add(messageId);
          anchorRef.current = messageId;
          return next;
        }

        next.clear();
        next.add(messageId);
        anchorRef.current = messageId;
        return next;
      });
    },
    [messages.items],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }, []);

  // A message can be deleted (by its author, in another tab, or by a live
  // socket event) while it is still held as a selected agent-context
  // message. Without this, the composer's "N selected" banner and the
  // eventual send would silently keep counting a message that no longer
  // exists — prune the selection whenever the underlying message list
  // changes so it always reflects what can actually be sent as context.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const liveIds = new Set(messages.items.map((message) => message.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [messages.items]);

  const exitSelectionMode = useCallback(() => {
    setIsSelecting(false);
    clearSelection();
  }, [clearSelection]);

  const handleSend = useCallback(
    async (
      blocks: MessageBlock[],
      mentions: string[],
      agentSessionId: string | null,
      contextMessageIds: string[],
    ) => {
      await sendMessage({
        blocks,
        mentions,
        agentSessionId,
        contextMessageIds: contextMessageIds.length > 0 ? contextMessageIds : undefined,
      });
    },
    [sendMessage],
  );

  const requestAgent = useCallback((prompt: string) => {
    setAgentPrompt(prompt);
    setIsAgentDialogOpen(true);
  }, []);

  const handleDelete = useCallback(
    (messageId: string) => {
      void deleteMessage(messageId).catch((error: unknown) => {
        toast({
          body: error instanceof ApiError ? error.message : 'Could not delete that message.',
          type: 'error',
        });
      });
    },
    [deleteMessage, toast],
  );

  if (!activeConversation || !activeConversationId) {
    return (
      <main className="ta-main">
        <div className="ta-centered">
          <EmptyState
            title="Pick a conversation"
            description="Choose a chat on the left, or start a new one. Type @Agent in any chat to put Claude Code, Codex, or OpenCode to work on a repository."
            icon={<Icon icon="menu" size="lg" />}
          />
        </div>
      </main>
    );
  }

  const others = activeConversation.members.filter((member) => member.id !== me.id);
  const onlineCount = others.filter((member) => onlineUserIds.has(member.id)).length;

  return (
    <main className="ta-main">
      <VStack gap={0} padding={3}>
        <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
          <HStack gap={3} vAlign="center">
            <IconButton
              label="Back to chats"
              icon={<Icon icon="chevronLeft" />}
              variant="ghost"
              size="sm"
              onClick={() => selectConversation(null)}
            />
            <Avatar name={activeConversation.title} size="md" tooltip={false} />
            <VStack gap={0}>
              <Text type="large" weight="semibold" maxLines={1}>
                {activeConversation.title}
              </Text>
              <Text type="supporting" color="secondary">
                {activeConversation.type === 'group'
                  ? `${activeConversation.members.length} members · ${onlineCount} online`
                  : onlineCount > 0
                    ? 'Online'
                    : 'Offline'}
              </Text>
            </VStack>
          </HStack>

          <HStack gap={2} vAlign="center">
            {agents.filter((agent) => agent.status !== 'closed').length > 0 ? (
              <Badge
                variant="purple"
                label={`${agents.filter((a) => a.status !== 'closed').length} agent(s)`}
              />
            ) : null}
            {/* AvatarGroup does not slice for you: pass the visible avatars
                and an explicit overflow indicator. */}
            {activeConversation.type === 'group' ? (
              <AvatarGroup size="sm">
                {activeConversation.members.slice(0, 5).map((member) => (
                  <Avatar key={member.id} name={member.displayName} size="sm" />
                ))}
                {activeConversation.members.length > 5 ? (
                  <AvatarGroupOverflow count={activeConversation.members.length - 5} />
                ) : null}
              </AvatarGroup>
            ) : null}
            <Button
              label={isSelecting ? 'Done selecting' : 'Select messages'}
              size="sm"
              variant={isSelecting ? 'primary' : 'ghost'}
              icon={<Icon icon="checkDouble" />}
              tooltip="Pick messages to hand an agent as context"
              onClick={() => (isSelecting ? exitSelectionMode() : setIsSelecting(true))}
            />
          </HStack>
        </HStack>
      </VStack>

      <Divider />

      <ChatLayout
        composer={
          <Composer
            conversationId={activeConversationId}
            members={activeConversation.members}
            agents={agents}
            selectedMessageIds={[...selectedIds]}
            onClearSelection={clearSelection}
            onSend={handleSend}
            onRequestAgent={requestAgent}
            onTyping={setTyping}
          />
        }
      >
        <MessageList
          messages={messages.items}
          agents={agents}
          membersById={membersById}
          currentUserId={me.id}
          isLoadingOlder={messages.isLoading}
          hasMore={messages.hasMore}
          onLoadOlder={loadOlderMessages}
          selectedIds={isSelecting ? selectedIds : null}
          onSelectMessage={handleSelectMessage}
          onDeleteMessage={handleDelete}
        />
      </ChatLayout>

      {typingUsers.length > 0 ? (
        <HStack gap={2} padding={2} vAlign="center">
          <Text type="supporting" color="secondary">
            {typingUsers.map((user) => user.firstName).join(', ')}{' '}
            {typingUsers.length === 1 ? 'is' : 'are'} typing…
          </Text>
        </HStack>
      ) : null}

      <AgentStarterDialog
        isOpen={isAgentDialogOpen}
        onOpenChange={setIsAgentDialogOpen}
        initialPrompt={agentPrompt}
        contextMessageIds={[...selectedIds]}
        onStarted={() => {
          exitSelectionMode();
          setAgentPrompt('');
        }}
      />
    </main>
  );
}
