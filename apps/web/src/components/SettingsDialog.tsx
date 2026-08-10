import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Selector } from '@astryxdesign/core/Selector';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  HARNESS_LABELS,
  type AgentSessionWithContext,
  type CredentialSummary,
  type Repository,
  type SystemStatus,
} from '@teamagents/shared';
import { ApiError, api } from '../lib/api.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { TrashIcon } from './icons.js';

interface SettingsDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export function SettingsDialog({ isOpen, onOpenChange }: SettingsDialogProps): ReactNode {
  const [tab, setTab] = useState('repositories');
  // Closing an agent from the Agents tab can unblock a repository deletion, so
  // the two panels share a refresh signal.
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((value) => value + 1), []);

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={760} purpose="form" maxHeight="85vh">
      {/* Passing onOpenChange is what renders the close button. */}
      <DialogHeader title="Repositories & credentials" onOpenChange={onOpenChange} />
      <VStack gap={3} padding={4}>
        {/* Narrow phone widths (e.g. 390px) can't fit all four tab labels;
            without this the strip is silently clipped by the Dialog's own
            `overflow: hidden` with no way to reach "System". */}
        <div className="ta-tab-scroll">
          <TabList value={tab} onChange={setTab} hasDivider>
            <Tab value="repositories" label="Repositories" />
            <Tab value="credentials" label="Credentials" />
            <Tab value="agents" label="Agents" />
            <Tab value="system" label="System" />
          </TabList>
        </div>

        <StackItem size="fill" isScrollable>
          {tab === 'repositories' ? <RepositoriesPanel revision={revision} onChanged={bump} /> : null}
          {tab === 'credentials' ? <CredentialsPanel onChanged={bump} /> : null}
          {tab === 'agents' ? <AgentsPanel revision={revision} onChanged={bump} /> : null}
          {tab === 'system' ? <SystemPanel /> : null}
        </StackItem>
      </VStack>
    </Dialog>
  );
}

function RepositoriesPanel({
  revision,
  onChanged,
}: {
  revision: number;
  onChanged: () => void;
}): ReactNode {
  const toast = useAppToast();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [credentialId, setCredentialId] = useState<string>('');
  /** Repository id awaiting a force-delete confirmation. */
  const [blocked, setBlocked] = useState<{ id: string; message: string } | null>(null);

  const refresh = useCallback(async () => {
    const [repositoryPage, credentialPage] = await Promise.all([
      api.listRepositories(),
      api.listCredentials(),
    ]);
    setRepositories(repositoryPage.items);
    setCredentials(credentialPage.items);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const create = async () => {
    try {
      await api.createRepository({
        name: name.trim(),
        url: url.trim(),
        credentialId: credentialId || null,
        defaultBranch: branch.trim() || null,
      });
      setName('');
      setUrl('');
      setBranch('');
      setCredentialId('');
      await refresh();
      onChanged();
      toast({ body: 'Repository added.' });
    } catch (error) {
      toast({
        body: error instanceof ApiError ? error.message : 'Could not add that repository.',
        type: 'error',
      });
    }
  };

  const remove = async (repository: Repository, force: boolean) => {
    try {
      await api.deleteRepository(repository.id, force);
      setBlocked(null);
      await refresh();
      onChanged();
      toast({ body: `Removed "${repository.name}".` });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'repository_in_use') {
        // Rather than a dead end, offer the override right where it happened.
        setBlocked({ id: repository.id, message: error.message });
        return;
      }
      toast({
        body: error instanceof ApiError ? error.message : 'Could not remove it.',
        type: 'error',
      });
    }
  };

  return (
    <VStack gap={4}>
      <Card padding={3} variant="muted">
        <VStack gap={3}>
          <Text type="label" weight="semibold">
            Add a repository
          </Text>
          {/* Both fields carry a description so their inputs stay on the same
              baseline; a lone description shifts one column down. */}
          <HStack gap={3} vAlign="start">
            <TextInput
              label="Name"
              value={name}
              onChange={setName}
              placeholder="my-service"
              description="Folder name inside the sandbox"
              width="100%"
            />
            <TextInput
              label="Default branch"
              value={branch}
              onChange={setBranch}
              placeholder="main"
              description="Leave blank for the remote default"
              isOptional
              width="100%"
            />
          </HStack>
          <TextInput
            label="Clone URL"
            value={url}
            onChange={setUrl}
            placeholder="https://github.com/org/repo.git or git@github.com:org/repo.git"
            description="HTTPS and SSH are both supported; the protocol is detected automatically"
          />
          <Selector
            label="Credential"
            value={credentialId}
            onChange={(value) => setCredentialId(value ?? '')}
            placeholder="No credential (public repository)"
            hasClear
            options={credentials.map((credential) => ({
              value: credential.id,
              label: `${credential.name} (${credential.type === 'ssh_key' ? 'SSH key' : 'token'})`,
            }))}
          />
          <HStack hAlign="end">
            <Button
              label="Add repository"
              variant="primary"
              isDisabled={!name.trim() || !url.trim()}
              clickAction={create}
            />
          </HStack>
        </VStack>
      </Card>

      <Divider />

      {repositories.length === 0 ? (
        <EmptyState
          title="No repositories yet"
          description="Add one above so agents can clone it into their sandbox."
          isCompact
        />
      ) : (
        <VStack gap={2}>
          {repositories.map((repository) => (
            <Card key={repository.id} padding={3}>
              <VStack gap={2}>
                <HStack gap={3} vAlign="center" hAlign="between">
                  <VStack gap={0}>
                    <HStack gap={2} vAlign="center">
                      <Text type="label" weight="semibold">
                        {repository.name}
                      </Text>
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
                    <Text type="supporting" color="secondary">
                      {repository.url}
                      {repository.defaultBranch ? ` · ${repository.defaultBranch}` : ''}
                    </Text>
                  </VStack>
                  <Button
                    label="Remove"
                    size="sm"
                    variant="destructive"
                    icon={<Icon icon={TrashIcon} />}
                    clickAction={() => remove(repository, false)}
                  />
                </HStack>

                {blocked?.id === repository.id ? (
                  <Card padding={2} variant="orange">
                    <VStack gap={2}>
                      <Text type="supporting">{blocked.message}</Text>
                      <HStack gap={2} hAlign="end">
                        <Button label="Cancel" size="sm" variant="ghost" onClick={() => setBlocked(null)} />
                        <Button
                          label="Delete anyway"
                          size="sm"
                          variant="destructive"
                          clickAction={() => remove(repository, true)}
                        />
                      </HStack>
                    </VStack>
                  </Card>
                ) : null}
              </VStack>
            </Card>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

function CredentialsPanel({ onChanged }: { onChanged: () => void }): ReactNode {
  const toast = useAppToast();
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [type, setType] = useState<'https_token' | 'ssh_key'>('https_token');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const refresh = useCallback(async () => {
    const page = await api.listCredentials();
    setCredentials(page.items);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    try {
      await api.createCredential({
        name: name.trim(),
        type,
        username: username.trim() || undefined,
        token: type === 'https_token' ? token : undefined,
        privateKey: type === 'ssh_key' ? privateKey : undefined,
        passphrase: type === 'ssh_key' && passphrase ? passphrase : undefined,
      });
      setName('');
      setUsername('');
      setToken('');
      setPrivateKey('');
      setPassphrase('');
      await refresh();
      onChanged();
      toast({ body: 'Credential stored and encrypted.' });
    } catch (error) {
      toast({
        body: error instanceof ApiError ? error.message : 'Could not store that credential.',
        type: 'error',
      });
    }
  };

  return (
    <VStack gap={4}>
      <Card padding={3} variant="muted">
        <VStack gap={3}>
          <Text type="label" weight="semibold">
            Add a credential
          </Text>
          <Text type="supporting" color="secondary">
            Secrets are encrypted at rest and never returned by the API again. Bind a credential to
            a repository, and agents receive it only inside their own sandbox.
          </Text>

          <HStack gap={3} vAlign="start">
            <TextInput
              label="Name"
              value={name}
              onChange={setName}
              placeholder="github-bot"
              description="How you will pick it later"
              width="100%"
            />
            <Selector
              label="Type"
              value={type}
              onChange={(value) => setType(value as 'https_token' | 'ssh_key')}
              description="Must match the remote's protocol"
              options={[
                { value: 'https_token', label: 'HTTPS access token' },
                { value: 'ssh_key', label: 'SSH private key' },
              ]}
              width="100%"
            />
          </HStack>

          {type === 'https_token' ? (
            <>
              <TextInput
                label="Git username"
                value={username}
                onChange={setUsername}
                placeholder="x-access-token"
                isOptional
              />
              <TextInput
                label="Access token"
                type="password"
                value={token}
                onChange={setToken}
                placeholder="ghp_…"
              />
            </>
          ) : (
            <>
              <VStack gap={1}>
                <Text type="label">Private key</Text>
                <textarea
                  className="ta-composer-code"
                  value={privateKey}
                  onChange={(event) => setPrivateKey(event.target.value)}
                  placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                  aria-label="Private key"
                />
              </VStack>
              <TextInput
                label="Passphrase"
                type="password"
                value={passphrase}
                onChange={setPassphrase}
                isOptional
              />
            </>
          )}

          <HStack hAlign="end">
            <Button
              label="Store credential"
              variant="primary"
              isDisabled={!name.trim() || (type === 'https_token' ? !token.trim() : !privateKey.trim())}
              clickAction={create}
            />
          </HStack>
        </VStack>
      </Card>

      <Divider />

      {credentials.length === 0 ? (
        <EmptyState title="No credentials yet" description="Add one to clone private repositories." isCompact />
      ) : (
        <VStack gap={2}>
          {credentials.map((credential) => (
            <Card key={credential.id} padding={3}>
              <HStack gap={3} vAlign="center" hAlign="between">
                <VStack gap={0}>
                  <Text type="label" weight="semibold">
                    {credential.name}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {credential.type === 'ssh_key'
                      ? 'SSH private key'
                      : `HTTPS token${credential.username ? ` · ${credential.username}` : ''}`}
                  </Text>
                </VStack>
                <Button
                  label="Delete"
                  size="sm"
                  variant="destructive"
                  icon={<Icon icon={TrashIcon} />}
                  clickAction={async () => {
                    try {
                      await api.deleteCredential(credential.id);
                      await refresh();
                      onChanged();
                    } catch (error) {
                      toast({
                        body: error instanceof ApiError ? error.message : 'Could not delete it.',
                        type: 'error',
                      });
                    }
                  }}
                />
              </HStack>
            </Card>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

/**
 * Every agent session across every conversation, so one can always be found and
 * closed — including the session that is holding a repository open.
 */
function AgentsPanel({
  revision,
  onChanged,
}: {
  revision: number;
  onChanged: () => void;
}): ReactNode {
  const toast = useAppToast();
  const [sessions, setSessions] = useState<AgentSessionWithContext[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showAllClosed, setShowAllClosed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.listAllAgents());
      setLoadError(null);
    } catch (error) {
      // Without this the panel would sit on "Loading…" forever and give the
      // user no idea that anything went wrong.
      setLoadError(error instanceof ApiError ? error.message : 'Could not load agent sessions.');
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  if (loadError) {
    return (
      <VStack gap={2}>
        <Text type="supporting">{loadError}</Text>
        <HStack>
          <Button label="Try again" size="sm" variant="secondary" clickAction={refresh} />
        </HStack>
      </VStack>
    );
  }

  if (sessions === null) return <Text type="supporting">Loading agent sessions…</Text>;

  const open = sessions.filter((session) => session.status !== 'closed');
  const closed = sessions.filter((session) => session.status === 'closed');

  return (
    <VStack gap={3}>
      <Text type="supporting" color="secondary">
        Closing a session stops its harness and permanently erases its sandbox, including any
        uncommitted work. The conversation history and trace are kept.
      </Text>

      {open.length === 0 ? (
        <EmptyState title="No open agent sessions" description="Nothing is holding a sandbox." isCompact />
      ) : (
        <VStack gap={2}>
          {open.map((session) => (
            <Card key={session.id} padding={3} data-session-row={session.id}>
              <VStack gap={2}>
                <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
                  <VStack gap={0}>
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      <Text type="label" weight="semibold" maxLines={1}>
                        {session.title}
                      </Text>
                      <Badge variant="purple" label={HARNESS_LABELS[session.harness]} />
                      <Badge
                        variant={session.status === 'error' ? 'error' : 'info'}
                        label={session.status}
                      />
                    </HStack>
                    <Text type="supporting" color="secondary">
                      in {session.conversationTitle}
                      {session.repositories.length > 0
                        ? ` · ${session.repositories.map((r) => r.name).join(', ')}`
                        : ''}
                    </Text>
                  </VStack>
                  <Button
                    label="Close & erase"
                    size="sm"
                    variant="destructive"
                    onClick={() => setConfirming(session.id)}
                  />
                </HStack>

                {confirming === session.id ? (
                  <Card padding={2} variant="orange">
                    <HStack gap={3} vAlign="center" hAlign="between">
                      <Text type="supporting">Erase this sandbox permanently?</Text>
                      <HStack gap={2}>
                        <Button label="Cancel" size="sm" variant="ghost" onClick={() => setConfirming(null)} />
                        <Button
                          label="Erase"
                          size="sm"
                          variant="destructive"
                          clickAction={async () => {
                            try {
                              await api.closeAgent(session.id);
                              setConfirming(null);
                              await refresh();
                              onChanged();
                              toast({ body: `Closed "${session.title}".` });
                            } catch (error) {
                              toast({
                                body:
                                  error instanceof ApiError ? error.message : 'Could not close it.',
                                type: 'error',
                              });
                            }
                          }}
                        />
                      </HStack>
                    </HStack>
                  </Card>
                ) : null}
              </VStack>
            </Card>
          ))}
        </VStack>
      )}

      {closed.length > 0 ? (
        <>
          <Divider label={`${closed.length} closed`} />
          <VStack gap={1}>
            {(showAllClosed ? closed : closed.slice(0, 20)).map((session) => (
              <HStack key={session.id} gap={2} vAlign="center" data-closed-session-row={session.id}>
                <Text type="supporting" color="disabled" maxLines={1}>
                  {session.title} · {session.conversationTitle}
                </Text>
              </HStack>
            ))}
          </VStack>
          {!showAllClosed && closed.length > 20 ? (
            <Button
              label={`Show all ${closed.length}`}
              size="sm"
              variant="ghost"
              onClick={() => setShowAllClosed(true)}
            />
          ) : null}
        </>
      ) : null}
    </VStack>
  );
}

function SystemPanel(): ReactNode {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    void api.systemStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  if (!status) return <Text type="supporting">Loading system status…</Text>;

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <VStack gap={2}>
          <Text type="label" weight="semibold">
            Sandbox
          </Text>
          <HStack gap={2} vAlign="center">
            <Badge
              variant={status.bubblewrap.available ? 'success' : 'error'}
              label={status.bubblewrap.available ? 'bubblewrap ready' : 'unavailable'}
            />
            <Text type="supporting" color="secondary">
              {status.bubblewrap.version ?? status.bubblewrap.reason ?? ''}
            </Text>
          </HStack>
          {!status.sandboxEnabled ? (
            <Text type="supporting" color="primary">
              Sandboxing is disabled — agents run directly on the host.
            </Text>
          ) : null}
        </VStack>
      </Card>

      <Card padding={3}>
        <VStack gap={2}>
          <Text type="label" weight="semibold">
            Agent harnesses
          </Text>
          {status.harnesses.map((harness) => (
            <HStack key={harness.id} gap={2} vAlign="center" hAlign="between">
              <Text type="body">{harness.label}</Text>
              <HStack gap={2} vAlign="center">
                <Text type="supporting" color="secondary">
                  {harness.version ?? harness.reason ?? ''}
                </Text>
                <Badge
                  variant={harness.available ? 'success' : 'neutral'}
                  label={harness.available ? 'installed' : 'missing'}
                />
              </HStack>
            </HStack>
          ))}
        </VStack>
      </Card>

      <Card padding={3}>
        <VStack gap={1}>
          <Text type="label" weight="semibold">
            Storage
          </Text>
          <Text type="supporting" color="secondary">
            Data directory: {status.dataDir}
          </Text>
          <Text type="supporting" color="secondary">
            Upload limit: {Math.floor(status.maxUploadBytes / (1024 * 1024))} MB
          </Text>
        </VStack>
      </Card>
    </VStack>
  );
}
