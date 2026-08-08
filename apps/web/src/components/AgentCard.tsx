import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import {
  HARNESS_LABELS,
  type AgentEvent,
  type AgentSession,
  type AgentSessionStatus,
  type MessageWithAuthor,
  type UserPublic,
} from '@teamagents/shared';
import { useChat } from '../state/ChatContext.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { MessageBlocks } from './blocks/MessageBlocks.js';
import { AgentQuestionCard } from './AgentQuestionCard.js';
import { AgentIcon } from './icons.js';

const STATUS_META: Record<
  AgentSessionStatus,
  { label: string; variant: 'neutral' | 'info' | 'success' | 'warning' | 'error'; busy: boolean }
> = {
  provisioning: { label: 'Preparing sandbox', variant: 'info', busy: true },
  running: { label: 'Working', variant: 'info', busy: true },
  waiting_input: { label: 'Needs your answer', variant: 'warning', busy: false },
  idle: { label: 'Ready', variant: 'success', busy: false },
  error: { label: 'Failed', variant: 'error', busy: false },
  closed: { label: 'Closed', variant: 'neutral', busy: false },
};

interface AgentCardProps {
  session: AgentSession;
  /** Everything said in this agent's thread, oldest first. */
  messages: MessageWithAuthor[];
  membersById: Map<string, UserPublic>;
  currentUserId: string;
}

/**
 * One agent sub-session, rendered as a self-contained block.
 *
 * Everything belonging to the agent lives inside this card — its output, the
 * prompts people sent it, its questions, and its trace — rather than being
 * scattered through the conversation as if the agent were another member. A
 * conversation can hold any number of these, each with its own sandbox.
 */
export function AgentCard({
  session,
  messages,
  membersById,
  currentUserId,
}: AgentCardProps): ReactNode {
  const { traceFor, loadTrace, closeAgent, abortAgent } = useChat();
  const toast = useAppToast();
  const [isTraceOpen, setIsTraceOpen] = useState(false);
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [isConfirmingClose, setIsConfirmingClose] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const status = STATUS_META[session.status];
  const trace = traceFor(session.id);

  const toggleTrace = async () => {
    const next = !isTraceOpen;
    setIsTraceOpen(next);
    // Traces are fetched only when opened; live events then stream in.
    if (next && trace.length === 0) await loadTrace(session.id);
  };

  return (
    <div className="ta-agent-card">
      <VStack gap={3}>
        <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
          <HStack gap={2} vAlign="center">
            <Icon icon={AgentIcon} color="accent" />
            <Text type="label" weight="semibold">
              {session.title}
            </Text>
            <Badge variant="purple" label={HARNESS_LABELS[session.harness]} />
          </HStack>

          <HStack gap={2} vAlign="center">
            {status.busy ? <Spinner size="sm" label="" /> : null}
            <Badge variant={status.variant} label={status.label} />
          </HStack>
        </HStack>

        {session.repositories.length > 0 ? (
          <HStack gap={2} wrap="wrap" vAlign="center">
            <Text type="supporting" color="secondary">
              Repositories:
            </Text>
            {session.repositories.map((repository) => (
              <Badge
                key={repository.repositoryId}
                variant={repository.cloneError ? 'error' : repository.cloned ? 'green' : 'neutral'}
                label={repository.name}
              />
            ))}
          </HStack>
        ) : (
          <Text type="supporting" color="secondary">
            No repositories bound — the agent works in an empty sandbox.
          </Text>
        )}

        {session.lastError ? (
          <Text type="supporting" color="primary">
            {session.lastError}
          </Text>
        ) : null}

        {messages.length > 0 ? (
          <>
            <Divider />
            <VStack gap={3}>
              {messages.map((message) => (
                <AgentThreadMessage
                  key={message.id}
                  message={message}
                  session={session}
                  membersById={membersById}
                  currentUserId={currentUserId}
                />
              ))}
            </VStack>
          </>
        ) : null}

        <Divider />

        <HStack gap={2} wrap="wrap" vAlign="center">
          <Button
            label={isTraceOpen ? 'Hide trace' : 'Show trace'}
            size="sm"
            variant="ghost"
            icon={<Icon icon={isTraceOpen ? 'chevronDown' : 'chevronRight'} />}
            onClick={() => void toggleTrace()}
          />
          {status.busy ? (
            <Button
              label="Stop"
              size="sm"
              variant="secondary"
              icon={<Icon icon="stop" />}
              clickAction={async () => {
                await abortAgent(session.id);
                toast({ body: 'Asked the agent to stop.' });
              }}
            />
          ) : null}
          {session.status !== 'closed' ? (
            <Button
              label="Close & erase sandbox"
              size="sm"
              variant="destructive"
              onClick={() => setIsConfirmingClose(true)}
            />
          ) : null}
        </HStack>

        {session.sandboxPath ? (
          <Text type="supporting" color="secondary">
            <span className="ta-agent-meta">
              Sandbox: {session.sandboxPath} · {session.turnCount} turn
              {session.turnCount === 1 ? '' : 's'}
            </span>
          </Text>
        ) : null}

        {isTraceOpen ? (
          <TraceView
            events={trace}
            isLive={status.busy}
            showRawEvents={showRawEvents}
            onToggleRawEvents={setShowRawEvents}
          />
        ) : null}
      </VStack>

      <AlertDialog
        isOpen={isConfirmingClose}
        onOpenChange={setIsConfirmingClose}
        title="Close this agent and erase its sandbox?"
        description={
          'The sandbox, its cloned repositories, and any uncommitted work will be deleted permanently. ' +
          'The conversation history and trace are kept.'
        }
        actionLabel="Erase sandbox"
        cancelLabel="Keep it"
        actionVariant="destructive"
        isActionLoading={isClosing}
        onAction={async () => {
          setIsClosing(true);
          try {
            await closeAgent(session.id);
            toast({ body: `Closed "${session.title}" and erased its sandbox.` });
            // AlertDialog never closes itself; the caller decides when the
            // irreversible work has actually finished.
            setIsConfirmingClose(false);
          } catch {
            toast({ body: 'Could not close that agent.', type: 'error' });
          } finally {
            setIsClosing(false);
          }
        }}
      />
    </div>
  );
}

/** One entry in the agent's thread: its own output, a question, or a prompt. */
function AgentThreadMessage({
  message,
  session,
  membersById,
  currentUserId,
}: {
  message: MessageWithAuthor;
  session: AgentSession;
  membersById: Map<string, UserPublic>;
  currentUserId: string;
}): ReactNode {
  if (message.kind === 'agent_question' && message.question) {
    return <AgentQuestionCard question={message.question} />;
  }

  const isFromHuman = message.author.kind === 'user';
  const who = isFromHuman
    ? (message.authorUser?.displayName ?? 'Someone')
    : HARNESS_LABELS[session.harness];

  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        {isFromHuman ? (
          <Avatar name={who} size="xsm" tooltip={false} />
        ) : (
          <Icon icon={AgentIcon} size="sm" color="accent" />
        )}
        <Text type="supporting" weight="semibold">
          {who}
        </Text>
        <Text type="supporting" color="secondary">
          {new Date(message.createdAt).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </HStack>
      <div className="ta-agent-thread-body">
        <MessageBlocks
          blocks={message.blocks}
          membersById={membersById}
          currentUserId={currentUserId}
        />
      </div>
    </VStack>
  );
}

// --- trace -----------------------------------------------------------------

interface TraceRow {
  key: string;
  seq: number;
  kind: 'tool' | 'event';
  label: string;
  summary: string;
  detail: string | null;
  variant: 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'purple' | 'cyan';
  /** Set on paired tool rows once the result is known. */
  outcome?: 'ok' | 'failed';
}

const EVENT_VARIANT: Record<string, TraceRow['variant']> = {
  status: 'neutral',
  assistant_text: 'info',
  reasoning: 'neutral',
  question: 'warning',
  question_answered: 'success',
  warning: 'warning',
  error: 'error',
  turn_complete: 'success',
};

/**
 * Condenses the raw event stream into something readable.
 *
 * The harnesses emit a lot of bookkeeping — step boundaries, empty successes,
 * one result per tool call — which as a flat list reads as noise. Tool calls are
 * folded together with their results into a single row, and protocol chatter is
 * hidden behind a toggle rather than dropped, so the full record is still there
 * when something needs debugging.
 */
function buildTraceRows(events: AgentEvent[], showRawEvents: boolean): {
  rows: TraceRow[];
  hiddenCount: number;
} {
  const rows: TraceRow[] = [];
  const byToolId = new Map<string, TraceRow>();
  let hiddenCount = 0;

  for (const event of events) {
    if (event.type === 'raw') {
      if (showRawEvents) {
        rows.push({
          key: event.id,
          seq: event.seq,
          kind: 'event',
          label: 'raw',
          summary: event.summary,
          detail: event.detail,
          variant: 'neutral',
        });
      } else {
        hiddenCount++;
      }
      continue;
    }

    if (event.type === 'tool_use') {
      const toolId = String(event.data?.toolUseId ?? event.data?.callId ?? '');
      const row: TraceRow = {
        key: event.id,
        seq: event.seq,
        kind: 'tool',
        label: String(event.data?.tool ?? 'tool'),
        summary: event.summary,
        detail: event.detail,
        variant: 'purple',
      };
      if (toolId) byToolId.set(toolId, row);
      rows.push(row);
      continue;
    }

    if (event.type === 'tool_result') {
      const toolId = String(event.data?.toolUseId ?? event.data?.callId ?? '');
      const pending = toolId ? byToolId.get(toolId) : undefined;
      const failed = event.data?.isError === true || /^failed/i.test(event.summary);

      if (pending) {
        // Fold the outcome into the call that produced it.
        pending.outcome = failed ? 'failed' : 'ok';
        if (failed) pending.variant = 'error';
        if (event.detail) pending.detail = event.detail;
        byToolId.delete(toolId);
        continue;
      }

      // An orphan result is only worth a row when it actually says something.
      const body = event.summary.replace(/^(ok|failed):\s*/i, '').trim();
      if (!failed && !body) {
        hiddenCount++;
        continue;
      }
      rows.push({
        key: event.id,
        seq: event.seq,
        kind: 'event',
        label: 'result',
        summary: body || event.summary,
        detail: event.detail,
        variant: failed ? 'error' : 'cyan',
      });
      continue;
    }

    rows.push({
      key: event.id,
      seq: event.seq,
      kind: 'event',
      label: event.type,
      summary: event.summary,
      detail: event.detail,
      variant: EVENT_VARIANT[event.type] ?? 'neutral',
    });
  }

  return { rows, hiddenCount };
}

function TraceView({
  events,
  isLive,
  showRawEvents,
  onToggleRawEvents,
}: {
  events: AgentEvent[];
  isLive: boolean;
  showRawEvents: boolean;
  onToggleRawEvents: (value: boolean) => void;
}): ReactNode {
  const { rows, hiddenCount } = useMemo(
    () => buildTraceRows(events, showRawEvents),
    [events, showRawEvents],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Follows new events by default, and stops the moment the reader scrolls up
  // to look at something — resuming only when they return to the bottom.
  const [isPinned, setIsPinned] = useState(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !isPinned) return;
    element.scrollTop = element.scrollHeight;
  }, [rows.length, isPinned]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      setIsPinned(distanceFromBottom < 32);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  if (events.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        No trace events yet.
      </Text>
    );
  }

  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <Text type="supporting" color="secondary">
          {rows.length} event{rows.length === 1 ? '' : 's'}
          {hiddenCount > 0 ? ` · ${hiddenCount} protocol event${hiddenCount === 1 ? '' : 's'} hidden` : ''}
        </Text>
        <HStack gap={3} vAlign="center">
          {isLive && !isPinned ? (
            <Button
              label="Jump to latest"
              size="sm"
              variant="ghost"
              icon={<Icon icon="arrowDown" />}
              onClick={() => setIsPinned(true)}
            />
          ) : null}
          <Switch
            label="Raw events"
            value={showRawEvents}
            onChange={onToggleRawEvents}
            size="sm"
          />
        </HStack>
      </HStack>

      <div className="ta-trace" ref={scrollRef}>
        {rows.map((row) => (
          <TraceRowView key={row.key} row={row} />
        ))}
      </div>
    </VStack>
  );
}

function TraceRowView({ row }: { row: TraceRow }): ReactNode {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetail = Boolean(row.detail);

  return (
    <>
      <div
        className="ta-trace-row"
        data-clickable={hasDetail}
        onClick={hasDetail ? () => setIsExpanded((open) => !open) : undefined}
      >
        <Badge variant={row.variant} label={row.label} />
        <span className="ta-trace-summary">{row.summary}</span>
        {row.kind === 'tool' ? (
          <span className="ta-trace-outcome">
            {row.outcome === undefined ? (
              <Spinner size="sm" label="" />
            ) : (
              <Icon
                icon={row.outcome === 'ok' ? 'check' : 'error'}
                size="sm"
                color={row.outcome === 'ok' ? 'success' : 'error'}
                label={row.outcome === 'ok' ? 'succeeded' : 'failed'}
              />
            )}
          </span>
        ) : (
          <span className="ta-trace-outcome" />
        )}
      </div>
      {isExpanded && row.detail ? <pre className="ta-trace-detail">{row.detail}</pre> : null}
    </>
  );
}
