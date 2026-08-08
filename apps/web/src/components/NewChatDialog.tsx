import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { UserPublic } from '@teamagents/shared';
import { ApiError, api } from '../lib/api.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { useCurrentUser } from '../state/AuthContext.js';
import { useChat } from '../state/ChatContext.js';

interface NewChatDialogProps {
  mode: 'dm' | 'group' | null;
  onClose: () => void;
}

/**
 * The user directory, used to start a DM or assemble a group.
 *
 * Search matches email, username, or first+last name server-side, and results
 * are paginated — "load more" rather than an unbounded list.
 */
export function NewChatDialog({ mode, onClose }: NewChatDialogProps): ReactNode {
  const me = useCurrentUser();
  const { createConversation, selectConversation } = useChat();
  const toast = useAppToast();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserPublic[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<UserPublic[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const isOpen = mode !== null;

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setSelected([]);
      setGroupName('');
      setResults([]);
      setNextCursor(null);
    }
  }, [isOpen]);

  // Debounced so each keystroke does not fire a request.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);
    const timer = window.setTimeout(() => {
      api
        .searchUsers({ query: query.trim() || undefined, limit: 25 })
        .then((page) => {
          if (cancelled) return;
          setResults(page.items.filter((user) => user.id !== me.id));
          setNextCursor(page.nextCursor);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, isOpen, me.id]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const page = await api.searchUsers({
      query: query.trim() || undefined,
      cursor: nextCursor,
      limit: 25,
    });
    setResults((current) => [...current, ...page.items.filter((user) => user.id !== me.id)]);
    setNextCursor(page.nextCursor);
  };

  const selectedIds = useMemo(() => new Set(selected.map((user) => user.id)), [selected]);

  const toggle = (user: UserPublic) => {
    if (mode === 'dm') {
      void start([user.id]);
      return;
    }
    setSelected((current) =>
      current.some((candidate) => candidate.id === user.id)
        ? current.filter((candidate) => candidate.id !== user.id)
        : [...current, user],
    );
  };

  const start = async (memberIds: string[]) => {
    setIsCreating(true);
    try {
      const conversation = await createConversation(
        mode === 'dm'
          ? { type: 'dm', memberIds }
          : { type: 'group', memberIds, name: groupName.trim() },
      );
      selectConversation(conversation.id);
      onClose();
    } catch (error) {
      toast({
        body: error instanceof ApiError ? error.message : 'Could not start that chat.',
        type: 'error',
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => !open && onClose()} width={560} purpose="form">
      <DialogHeader
        title={mode === 'group' ? 'New group chat' : 'New direct message'}
        onOpenChange={(open) => !open && onClose()}
      />
      <VStack gap={3} padding={4}>
        {mode === 'group' ? (
          <TextInput
            label="Group name"
            value={groupName}
            onChange={setGroupName}
            placeholder="Platform Team"
            isRequired
          />
        ) : null}

        <TextInput
          label="Search people"
          value={query}
          onChange={setQuery}
          placeholder="Search by name, username, or email"
          startIcon="search"
          hasClear
          hasAutoFocus
        />

        {mode === 'group' && selected.length > 0 ? (
          <HStack gap={2} wrap="wrap">
            {selected.map((user) => (
              <Badge key={user.id} variant="blue" label={user.displayName} />
            ))}
          </HStack>
        ) : null}

        <Divider />

        <StackItem size="fill" isScrollable>
          <VStack gap={1} height={320}>
            {isLoading && results.length === 0 ? (
              <HStack hAlign="center" padding={4}>
                <Spinner size="sm" label="Searching" />
              </HStack>
            ) : results.length === 0 ? (
              <EmptyState
                title="Nobody found"
                description="Try a different name, username, or email."
                isCompact
              />
            ) : (
              <>
                {results.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    className="ta-autocomplete-item"
                    data-active={selectedIds.has(user.id)}
                    onClick={() => toggle(user)}
                  >
                    <Avatar name={user.displayName} size="sm" tooltip={false} />
                    <VStack gap={0}>
                      <Text type="label">{user.displayName}</Text>
                      <Text type="supporting" color="secondary">
                        @{user.username} · {user.email}
                      </Text>
                    </VStack>
                    {selectedIds.has(user.id) ? <Icon icon="check" color="accent" /> : null}
                  </button>
                ))}
                {nextCursor ? (
                  <Button
                    label="Load more people"
                    variant="ghost"
                    size="sm"
                    clickAction={loadMore}
                  />
                ) : null}
              </>
            )}
          </VStack>
        </StackItem>

        {mode === 'group' ? (
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              label={`Create group${selected.length ? ` (${selected.length})` : ''}`}
              variant="primary"
              isLoading={isCreating}
              isDisabled={selected.length === 0 || groupName.trim().length === 0}
              onClick={() => void start(selected.map((user) => user.id))}
            />
          </HStack>
        ) : null}
      </VStack>
    </Dialog>
  );
}
