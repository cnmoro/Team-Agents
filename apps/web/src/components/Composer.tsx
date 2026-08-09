import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';

import {
  CODE_LANGUAGES,
  type AgentSession,
  type MessageBlock,
  type UploadedFile,
  type UserPublic,
} from '@teamagents/shared';
import { ApiError, api } from '../lib/api.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { formatBytes } from './blocks/MessageBlocks.js';
import { AgentIcon, CodeBlockIcon, PaperclipIcon } from './icons.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface ComposerProps {
  conversationId: string;
  members: UserPublic[];
  agents: AgentSession[];
  selectedMessageIds: string[];
  onClearSelection: () => void;
  onSend: (
    blocks: MessageBlock[],
    mentions: string[],
    agentSessionId: string | null,
    contextMessageIds: string[],
  ) => Promise<void>;
  onRequestAgent: (prompt: string) => void;
  onTyping: (isTyping: boolean) => void;
}

interface PendingCode {
  id: string;
  language: string;
  code: string;
}

/** Entry shown in the `@` popup: either a person or the agent launcher. */
type MentionCandidate =
  | { kind: 'user'; user: UserPublic }
  | { kind: 'agent' };

export function Composer({
  conversationId,
  members,
  agents,
  selectedMessageIds,
  onClearSelection,
  onSend,
  onRequestAgent,
  onTyping,
}: ComposerProps): ReactNode {
  const toast = useAppToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number | null>(null);

  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [pendingCode, setPendingCode] = useState<PendingCode[]>([]);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [agentTarget, setAgentTarget] = useState<string | null>(null);

  // `@` autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const openAgents = useMemo(
    () => agents.filter((agent) => agent.status !== 'closed'),
    [agents],
  );

  // A closed agent must not stay selected as the composer's target.
  useEffect(() => {
    if (agentTarget && !openAgents.some((agent) => agent.id === agentTarget)) {
      setAgentTarget(null);
    }
  }, [openAgents, agentTarget]);

  const candidates = useMemo((): MentionCandidate[] => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.toLowerCase();
    const people: MentionCandidate[] = members
      .filter(
        (member) =>
          member.displayName.toLowerCase().includes(needle) ||
          member.username.toLowerCase().includes(needle),
      )
      .slice(0, 8)
      .map((user) => ({ kind: 'user' as const, user }));

    // "Agent" is always offered, so `@Agent` works even in a busy group.
    return 'agent'.startsWith(needle) || needle === ''
      ? [{ kind: 'agent' }, ...people]
      : people;
  }, [mentionQuery, members]);

  useEffect(() => setActiveIndex(0), [mentionQuery]);

  /** Reads the `@token` immediately before the caret, if any. */
  const refreshMentionQuery = useCallback((value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const match = /(?:^|\s)@([\w.-]*)$/.exec(upToCaret);
    setMentionQuery(match ? (match[1] ?? '') : null);
  }, []);

  const handleChange = (value: string) => {
    setText(value);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    refreshMentionQuery(value, caret);

    onTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => onTyping(false), 2000);
  };

  const applyCandidate = (candidate: MentionCandidate) => {
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const match = /(?:^|\s)@([\w.-]*)$/.exec(before);
    if (!match) return;

    const start = before.length - match[0].length + (match[0].startsWith('@') ? 0 : 1);
    const prefix = text.slice(0, start);

    if (candidate.kind === 'agent') {
      // The agent flow needs a dialog, not a token: hand the dialog whatever
      // the user already typed and strip the trigger from the composer.
      const promptSoFar = `${prefix}${after}`.trim();
      setText('');
      setMentionQuery(null);
      onRequestAgent(promptSoFar);
      return;
    }

    const token = `@[${candidate.user.displayName}](${candidate.user.id}) `;
    const next = `${prefix}${token}${after}`;
    setText(next);
    setMentions((current) =>
      current.includes(candidate.user.id) ? current : [...current, candidate.user.id],
    );
    setMentionQuery(null);

    queueMicrotask(() => {
      const position = prefix.length + token.length;
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && candidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % candidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = candidates[activeIndex];
        if (candidate) applyCandidate(candidate);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const attachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_UPLOAD_BYTES) {
          toast({
            body: `"${file.name}" is ${formatBytes(file.size)} — the limit is 25 MB.`,
            type: 'error',
          });
          continue;
        }
        const uploaded = await api.uploadFile(conversationId, file);
        setAttachments((current) => [...current, uploaded]);
      }
    } catch (error) {
      toast({
        body: error instanceof ApiError ? error.message : 'Upload failed.',
        type: 'error',
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const buildBlocks = (): MessageBlock[] => {
    const blocks: MessageBlock[] = [];
    const trimmed = text.trim();
    if (trimmed) blocks.push({ type: 'text', text: trimmed });
    for (const snippet of pendingCode) {
      if (snippet.code.trim()) {
        blocks.push({ type: 'code', language: snippet.language, code: snippet.code });
      }
    }
    for (const file of attachments) {
      blocks.push(
        file.isImage
          ? {
              type: 'image',
              fileId: file.id,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
              width: file.width,
              height: file.height,
            }
          : {
              type: 'file',
              fileId: file.id,
              filename: file.filename,
              mimeType: file.mimeType,
              size: file.size,
            },
      );
    }
    return blocks;
  };

  const send = async () => {
    const blocks = buildBlocks();
    if (blocks.length === 0 || isSending) return;

    // A message selection only means something once it has somewhere to go:
    // targeting an existing agent carries it along as context, exactly like
    // starting a new one does. Aimed at "everyone" it is inert, since a plain
    // chat message has no context slot to put it in.
    const contextForAgent = agentTarget ? selectedMessageIds : [];

    setIsSending(true);
    try {
      // Only mentions still present in the text are sent; removing the token
      // from the message should remove the notification with it.
      const stillMentioned = mentions.filter((id) => text.includes(`(${id})`));
      await onSend(blocks, stillMentioned, agentTarget, contextForAgent);
      setText('');
      setMentions([]);
      setPendingCode([]);
      setAttachments([]);
      setMentionQuery(null);
      onTyping(false);
      if (contextForAgent.length > 0) onClearSelection();
    } catch (error) {
      toast({
        body: error instanceof ApiError ? error.message : 'Could not send that message.',
        type: 'error',
      });
    } finally {
      setIsSending(false);
    }
  };

  const canSend =
    !isSending && (text.trim().length > 0 || pendingCode.length > 0 || attachments.length > 0);

  return (
    <div className="ta-composer" style={{ position: 'relative' }}>
      <VStack gap={2}>
        {selectedMessageIds.length > 0 ? (
          <Card padding={2} variant="blue">
            <VStack gap={1}>
              <HStack gap={3} vAlign="center" hAlign="between">
                <HStack gap={2} vAlign="center">
                  <Icon icon="check" color="accent" size="sm" />
                  <Text type="supporting">
                    {selectedMessageIds.length} message
                    {selectedMessageIds.length === 1 ? '' : 's'} selected as agent context
                  </Text>
                </HStack>
                <HStack gap={2}>
                  <Button
                    label="Start a new agent"
                    size="sm"
                    variant="primary"
                    onClick={() => onRequestAgent(text.trim())}
                  />
                  <Button label="Clear" size="sm" variant="ghost" onClick={onClearSelection} />
                </HStack>
              </HStack>
              {agentTarget ? (
                <Text type="supporting" color="accent">
                  Sending will also hand these to {openAgents.find((a) => a.id === agentTarget)?.title
                    ?? 'the selected agent'} as context.
                </Text>
              ) : null}
            </VStack>
          </Card>
        ) : null}

        {pendingCode.map((snippet) => (
          <Card key={snippet.id} padding={2} variant="muted">
            <VStack gap={2}>
              <HStack gap={2} vAlign="center" hAlign="between">
                <Selector
                  label="Language"
                  isLabelHidden
                  size="sm"
                  variant="ghost"
                  value={snippet.language}
                  options={CODE_LANGUAGES as unknown as string[]}
                  onChange={(value) =>
                    setPendingCode((current) =>
                      current.map((item) =>
                        item.id === snippet.id ? { ...item, language: value } : item,
                      ),
                    )
                  }
                />
                <IconButton
                  label="Remove code block"
                  icon={<Icon icon="close" />}
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setPendingCode((current) => current.filter((item) => item.id !== snippet.id))
                  }
                />
              </HStack>
              <textarea
                className="ta-composer-code"
                value={snippet.code}
                placeholder={`Paste ${snippet.language} here…`}
                aria-label={`${snippet.language} code block`}
                onChange={(event) =>
                  setPendingCode((current) =>
                    current.map((item) =>
                      item.id === snippet.id ? { ...item, code: event.target.value } : item,
                    ),
                  )
                }
              />
            </VStack>
          </Card>
        ))}

        {attachments.length > 0 ? (
          <HStack gap={2} wrap="wrap">
            {attachments.map((file) => (
              <Badge
                key={file.id}
                variant={file.isImage ? 'green' : 'blue'}
                label={`${file.filename} (${formatBytes(file.size)})`}
                icon={
                  <button
                    type="button"
                    aria-label={`Remove ${file.filename}`}
                    onClick={() =>
                      setAttachments((current) => current.filter((item) => item.id !== file.id))
                    }
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    <Icon icon="close" size="xsm" />
                  </button>
                }
              />
            ))}
          </HStack>
        ) : null}

        {agentTarget ? (
          <HStack gap={2} vAlign="center">
            <Badge variant="purple" label="Replying to agent" />
            <Text type="supporting" color="secondary">
              {openAgents.find((agent) => agent.id === agentTarget)?.title}
            </Text>
            <Button
              label="Cancel"
              size="sm"
              variant="ghost"
              onClick={() => setAgentTarget(null)}
            />
          </HStack>
        ) : null}

        <textarea
          ref={textareaRef}
          className="ta-composer-input"
          value={text}
          rows={2}
          placeholder="Write a message.  Type @ to mention someone, or @Agent to run a coding agent."
          aria-label="Message"
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onClick={(event) =>
            refreshMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)
          }
          onBlur={() => {
            // Delayed so a click on a suggestion registers before the list closes.
            window.setTimeout(() => setMentionQuery(null), 150);
          }}
        />

        <HStack gap={2} vAlign="center" hAlign="between">
          <HStack gap={1} vAlign="center">
            <IconButton
              label="Attach a file"
              tooltip="Attach a file or image (max 25 MB)"
              icon={<Icon icon={PaperclipIcon} />}
              variant="ghost"
              size="sm"
              isLoading={isUploading}
              onClick={() => fileInputRef.current?.click()}
            />
            <IconButton
              label="Insert code block"
              tooltip="Insert a code block"
              icon={<Icon icon={CodeBlockIcon} />}
              variant="ghost"
              size="sm"
              onClick={() =>
                setPendingCode((current) => [
                  ...current,
                  { id: crypto.randomUUID(), language: 'plaintext', code: '' },
                ])
              }
            />
            <IconButton
              label="Run an agent"
              tooltip="Run a coding agent"
              icon={<Icon icon={AgentIcon} />}
              variant="ghost"
              size="sm"
              onClick={() => onRequestAgent(text.trim())}
            />
            {openAgents.length > 0 ? (
              <Selector
                label="Send to"
                isLabelHidden
                size="sm"
                variant="ghost"
                placeholder="Send to…"
                hasClear
                value={agentTarget}
                options={[
                  { value: '', label: 'Everyone in the chat' },
                  ...openAgents.map((agent) => ({ value: agent.id, label: agent.title })),
                ]}
                onChange={(value) => setAgentTarget(value ? value : null)}
              />
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => void attachFiles(event.target.files)}
            />
          </HStack>

          <HStack gap={2} vAlign="center">
            <Text type="supporting" color="disabled">
              Enter to send · Shift+Enter for a new line
            </Text>
            <Button
              label="Send"
              variant="primary"
              isDisabled={!canSend}
              isLoading={isSending}
              onClick={() => void send()}
            />
          </HStack>
        </HStack>
      </VStack>

      {mentionQuery !== null && candidates.length > 0 ? (
        <div className="ta-autocomplete" role="listbox" aria-label="Mention suggestions">
          {candidates.map((candidate, index) => (
            <button
              key={candidate.kind === 'agent' ? 'agent' : candidate.user.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="ta-autocomplete-item"
              data-active={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyCandidate(candidate)}
            >
              {candidate.kind === 'agent' ? (
                <>
                  <Icon icon={AgentIcon} color="accent" />
                  <VStack gap={0}>
                    <Text type="label">Agent</Text>
                    <Text type="supporting" color="secondary">
                      Run Claude Code, Codex, or OpenCode on a repository
                    </Text>
                  </VStack>
                </>
              ) : (
                <>
                  <Avatar name={candidate.user.displayName} size="sm" tooltip={false} />
                  <VStack gap={0}>
                    <Text type="label">{candidate.user.displayName}</Text>
                    <Text type="supporting" color="secondary">
                      @{candidate.user.username}
                    </Text>
                  </VStack>
                </>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
