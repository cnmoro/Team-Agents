import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import {
  HARNESSES,
  HARNESS_LABELS,
  type HarnessAvailability,
  type HarnessId,
  type Repository,
} from '@teamagents/shared';
import { ApiError, api } from '../lib/api.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { useChat } from '../state/ChatContext.js';

interface AgentStarterDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Prompt text carried over from the composer. */
  initialPrompt: string;
  /** Messages the user selected to hand the agent as context. */
  contextMessageIds: string[];
  onStarted: () => void;
}

/**
 * The `@Agent` flow: pick a harness, bind repositories, review the context, go.
 *
 * Harnesses that are not installed on the host are shown but disabled with the
 * reason, so the choice is never a dead end.
 */
export function AgentStarterDialog({
  isOpen,
  onOpenChange,
  initialPrompt,
  contextMessageIds,
  onStarted,
}: AgentStarterDialogProps): ReactNode {
  const { startAgent } = useChat();
  const toast = useAppToast();

  const [availability, setAvailability] = useState<HarnessAvailability[] | null>(null);
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [harness, setHarness] = useState<HarnessId | null>(null);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPrompt(initialPrompt);
    setError(null);
    void api
      .systemStatus()
      .then((status) => {
        setAvailability(status.harnesses);
        // Preselect the first working harness so the common case is one click.
        setHarness((current) => current ?? status.harnesses.find((h) => h.available)?.id ?? null);
      })
      .catch(() => setAvailability([]));
    void api
      .listRepositories()
      .then((page) => setRepositories(page.items))
      .catch(() => setRepositories([]));
  }, [isOpen, initialPrompt]);

  const availabilityById = useMemo(
    () => new Map((availability ?? []).map((entry) => [entry.id, entry])),
    [availability],
  );

  const submit = async () => {
    if (!harness) {
      setError('Pick a harness first.');
      return;
    }
    if (!prompt.trim()) {
      setError('Give the agent something to do.');
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      await startAgent({
        harness,
        repositoryIds: selectedRepoIds,
        prompt: prompt.trim(),
        contextMessageIds,
      });
      toast({ body: `${HARNESS_LABELS[harness]} is starting up.` });
      onOpenChange(false);
      onStarted();
      setSelectedRepoIds([]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start the agent.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={620} purpose="form">
      <DialogHeader title="Run an agent" onOpenChange={onOpenChange} />
      <VStack gap={4} padding={4}>
        <VStack gap={2}>
          <Text type="label" weight="semibold">
            1. Harness
          </Text>
          {availability === null ? (
            <Spinner size="sm" label="Checking which harnesses are installed" />
          ) : (
            <HStack gap={2} wrap="wrap">
              {HARNESSES.map((id) => {
                const entry = availabilityById.get(id);
                const isAvailable = entry?.available ?? false;
                return (
                  <Button
                    key={id}
                    label={HARNESS_LABELS[id]}
                    variant={harness === id ? 'primary' : 'secondary'}
                    isDisabled={!isAvailable}
                    tooltip={
                      isAvailable
                        ? (entry?.version ?? undefined)
                        : (entry?.reason ?? 'Not installed on this host')
                    }
                    onClick={() => setHarness(id)}
                  />
                );
              })}
            </HStack>
          )}
        </VStack>

        <Divider />

        <VStack gap={2}>
          <HStack gap={2} vAlign="center" hAlign="between">
            <Text type="label" weight="semibold">
              2. Repositories
            </Text>
            <Text type="supporting" color="secondary">
              {selectedRepoIds.length} selected
            </Text>
          </HStack>

          {repositories === null ? (
            <Spinner size="sm" label="Loading repositories" />
          ) : repositories.length === 0 ? (
            <EmptyState
              title="No repositories yet"
              description="Add one in Repositories & credentials. An agent can also run without any."
              isCompact
            />
          ) : (
            <StackItem size="fill" isScrollable>
              <VStack gap={1} height={200}>
                {repositories.map((repository) => (
                  <Card key={repository.id} padding={2} variant="muted">
                    <HStack gap={3} vAlign="center" hAlign="between">
                      <CheckboxInput
                        label={repository.name}
                        description={repository.url}
                        value={selectedRepoIds.includes(repository.id)}
                        onChange={(checked) =>
                          setSelectedRepoIds((current) =>
                            checked
                              ? [...current, repository.id]
                              : current.filter((id) => id !== repository.id),
                          )
                        }
                      />
                      <HStack gap={2} vAlign="center">
                        <Badge
                          variant={repository.protocol === 'ssh' ? 'purple' : 'blue'}
                          label={repository.protocol.toUpperCase()}
                        />
                        {repository.credentialName ? (
                          <Badge variant="neutral" label={repository.credentialName} />
                        ) : (
                          <Badge variant="warning" label="no credential" />
                        )}
                      </HStack>
                    </HStack>
                  </Card>
                ))}
              </VStack>
            </StackItem>
          )}
        </VStack>

        <Divider />

        <VStack gap={2}>
          <Text type="label" weight="semibold">
            3. Prompt
          </Text>
          <textarea
            className="ta-composer-code"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Please change the colour of the Create User button to blue"
            aria-label="Agent prompt"
          />
          {contextMessageIds.length > 0 ? (
            <HStack gap={2} vAlign="center">
              <Icon icon="info" color="accent" size="sm" />
              <Text type="supporting" color="secondary">
                {contextMessageIds.length} selected message
                {contextMessageIds.length === 1 ? '' : 's'} will be passed as context.
              </Text>
            </HStack>
          ) : null}
        </VStack>

        {error ? (
          <div role="alert">
            <Text type="supporting" color="primary">
              {error}
            </Text>
          </div>
        ) : null}

        <HStack gap={2} hAlign="end">
          <Button label="Cancel" variant="ghost" onClick={() => onOpenChange(false)} />
          <Button
            label="Start agent"
            variant="primary"
            isLoading={isBusy}
            onClick={() => void submit()}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
}
