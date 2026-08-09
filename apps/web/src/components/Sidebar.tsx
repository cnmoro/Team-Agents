import { useMemo, useState, type ReactNode } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Avatar } from '@astryxdesign/core/Avatar';
import { AvatarStatusDot } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Divider } from '@astryxdesign/core/Divider';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { ConversationSummary } from '@teamagents/shared';
import { useAuth, useCurrentUser } from '../state/AuthContext.js';
import { useChat } from '../state/ChatContext.js';
import { useThemeMode } from '../App.js';
import {
  MoonIcon,
  RepositoriesIcon,
  SignOutIcon,
  SunIcon,
  UserPlusIcon,
  UsersPlusIcon,
} from './icons.js';

interface SidebarProps {
  onOpenSettings: () => void;
  onNewChat: (mode: 'dm' | 'group') => void;
}

export function Sidebar({ onOpenSettings, onNewChat }: SidebarProps): ReactNode {
  const me = useCurrentUser();
  const { logout } = useAuth();
  const { mode, toggleMode } = useThemeMode();
  const {
    conversations,
    activeConversationId,
    selectConversation,
    onlineUserIds,
    isConnected,
  } = useChat();
  const [filter, setFilter] = useState('');
  const [isConfirmingSignOut, setIsConfirmingSignOut] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(needle) ||
        conversation.members.some((member) => member.displayName.toLowerCase().includes(needle)),
    );
  }, [conversations, filter]);

  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <aside className="ta-sidebar">
      <VStack gap={3} padding={3}>
        <HStack gap={2} vAlign="center" hAlign="between">
          <HStack gap={2} vAlign="center">
            <Avatar
              name={me.displayName}
              size="sm"
              tooltip={false}
              status={
                isConnected ? <AvatarStatusDot variant="success" label="Connected" /> : undefined
              }
            />
            <VStack gap={0}>
              <Text type="label" weight="semibold" maxLines={1}>
                {me.displayName}
              </Text>
              <Text type="supporting" color="secondary" maxLines={1}>
                @{me.username}
              </Text>
            </VStack>
          </HStack>

          <HStack gap={1} vAlign="center">
            {/* Shows the mode you are switching *to*, which is what people
                reach for: a sun to go light, a moon to go dark. */}
            <IconButton
              label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              tooltip={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              icon={<Icon icon={mode === 'dark' ? SunIcon : MoonIcon} />}
              variant="ghost"
              size="sm"
              onClick={toggleMode}
            />
            {/* Two destinations, so two buttons: a menu here only added a click
                and hid both behind an icon that says nothing about either. */}
            <IconButton
              label="Repositories & credentials"
              tooltip="Repositories & credentials"
              icon={<Icon icon={RepositoriesIcon} />}
              variant="ghost"
              size="sm"
              onClick={onOpenSettings}
            />
            <IconButton
              label="Sign out"
              tooltip="Sign out"
              icon={<Icon icon={SignOutIcon} />}
              variant="ghost"
              size="sm"
              onClick={() => setIsConfirmingSignOut(true)}
            />
          </HStack>
        </HStack>

        <HStack gap={2} vAlign="center" hAlign="between">
          <HStack gap={2} vAlign="center">
            <Text type="label" weight="semibold">
              Chats
            </Text>
            {totalUnread > 0 ? <Badge variant="error" label={String(totalUnread)} /> : null}
          </HStack>
          <HStack gap={1}>
            <IconButton
              label="New direct message"
              icon={<Icon icon={UserPlusIcon} />}
              variant="ghost"
              size="sm"
              tooltip="New direct message"
              onClick={() => onNewChat('dm')}
            />
            <IconButton
              label="New group"
              icon={<Icon icon={UsersPlusIcon} />}
              variant="ghost"
              size="sm"
              tooltip="New group chat"
              onClick={() => onNewChat('group')}
            />
          </HStack>
        </HStack>

        <TextInput
          label="Filter chats"
          isLabelHidden
          value={filter}
          onChange={setFilter}
          placeholder="Filter chats"
          startIcon="search"
          hasClear
          size="sm"
        />
      </VStack>

      <Divider />

      <StackItem size="fill" isScrollable>
        <VStack gap={0} padding={2}>
          {visible.length === 0 ? (
            <EmptyState
              title={filter ? 'No matches' : 'No conversations yet'}
              description={
                filter ? 'Try a different search.' : 'Start a direct message or create a group.'
              }
              isCompact
            />
          ) : (
            visible.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                isSelected={conversation.id === activeConversationId}
                isOnline={isOtherOnline(conversation, me.id, onlineUserIds)}
                onSelect={() => selectConversation(conversation.id)}
              />
            ))
          )}
        </VStack>
      </StackItem>

      {/*
        Signing out sits one pixel from the theme toggle and the settings
        button, and it drops everything you were reading. The same AlertDialog
        used for erasing a sandbox guards it — with a neutral action variant,
        because nothing is actually destroyed.
      */}
      <AlertDialog
        isOpen={isConfirmingSignOut}
        onOpenChange={setIsConfirmingSignOut}
        title="Sign out of TeamAgents?"
        description={
          'Your agent sessions keep running and their sandboxes are untouched — ' +
          'you will just need to sign in again to see them.'
        }
        actionLabel="Sign out"
        cancelLabel="Stay signed in"
        actionVariant="primary"
        isActionLoading={isSigningOut}
        onAction={async () => {
          setIsSigningOut(true);
          try {
            await logout();
          } finally {
            // Signing out unmounts this whole view, so the reset only matters
            // when the request failed and the dialog is still on screen.
            setIsSigningOut(false);
            setIsConfirmingSignOut(false);
          }
        }}
      />
    </aside>
  );
}

function isOtherOnline(
  conversation: ConversationSummary,
  myId: string,
  onlineUserIds: Set<string>,
): boolean {
  return conversation.members.some((member) => member.id !== myId && onlineUserIds.has(member.id));
}

interface ConversationRowProps {
  conversation: ConversationSummary;
  isSelected: boolean;
  isOnline: boolean;
  onSelect: () => void;
}

function ConversationRow({
  conversation,
  isSelected,
  isOnline,
  onSelect,
}: ConversationRowProps): ReactNode {
  const hasUnread = conversation.unreadCount > 0;

  return (
    <button
      type="button"
      className="ta-conversation-row"
      data-selected={isSelected}
      data-unread={hasUnread}
      onClick={onSelect}
      aria-current={isSelected ? 'true' : undefined}
    >
      <Avatar
        name={conversation.title}
        size="md"
        tooltip={false}
        status={
          conversation.type === 'dm' && isOnline ? (
            <AvatarStatusDot variant="success" label="Online" />
          ) : undefined
        }
      />

      <span className="ta-conversation-body">
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="body" maxLines={1} xstyle={undefined}>
            <span className="ta-conversation-title ta-truncate">{conversation.title}</span>
          </Text>
          {conversation.lastMessageAt ? (
            <Text type="supporting" color="secondary">
              {formatShortTime(conversation.lastMessageAt)}
            </Text>
          ) : null}
        </HStack>

        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting" color="secondary" maxLines={1}>
            <span className="ta-truncate">{conversation.lastMessagePreview ?? 'No messages yet'}</span>
          </Text>
          <HStack gap={1} vAlign="center">
            {conversation.hasMention ? (
              <StatusDot variant="accent" label="You were mentioned" isPulsing />
            ) : null}
            {hasUnread ? (
              <Badge
                variant={conversation.hasMention ? 'error' : 'info'}
                label={conversation.unreadCount > 99 ? '99+' : String(conversation.unreadCount)}
              />
            ) : null}
          </HStack>
        </HStack>
      </span>
    </button>
  );
}

/** Compact timestamp for the sidebar: time today, date otherwise. */
function formatShortTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
