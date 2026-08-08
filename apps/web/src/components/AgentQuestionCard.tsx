import { useState, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { AgentQuestionPayload } from '@teamagents/shared';
import { ApiError } from '../lib/api.js';
import { useAppToast } from '../hooks/useAppToast.js';
import { useChat } from '../state/ChatContext.js';

/**
 * A question the agent asked, rendered inline in the conversation.
 *
 * Anyone in the chat can answer — the first answer wins, and the card then
 * shows who answered what, so the rest of the team can see how the decision was
 * made rather than just its consequence.
 */
export function AgentQuestionCard({ question }: { question: AgentQuestionPayload }): ReactNode {
  const { answerAgent, conversations } = useChat();
  const toast = useAppToast();
  const [freeText, setFreeText] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const answeredBy = question.answeredBy
    ? conversations
        .flatMap((conversation) => conversation.members)
        .find((member) => member.id === question.answeredBy)
    : null;

  const submit = async (optionId: string | null, text: string | null) => {
    setIsBusy(true);
    try {
      await answerAgent(question.agentSessionId, {
        questionId: question.questionId,
        optionId,
        text,
      });
      setFreeText('');
    } catch (error) {
      toast({
        body:
          error instanceof ApiError
            ? error.message
            : 'Could not deliver that answer to the agent.',
        type: 'error',
      });
    } finally {
      setIsBusy(false);
    }
  };

  if (question.cancelled) {
    return (
      <Card padding={3} variant="muted" maxWidth={640}>
        <VStack gap={1}>
          <Text type="label">{question.question}</Text>
          <Text type="supporting" color="secondary">
            This question was cancelled before anyone answered.
          </Text>
        </VStack>
      </Card>
    );
  }

  if (question.answeredBy) {
    return (
      <Card padding={3} variant="green" maxWidth={640}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Icon icon="check" color="success" />
            <Text type="label">{question.question}</Text>
          </HStack>
          <Text type="supporting" color="secondary">
            {answeredBy?.displayName ?? 'Someone'} answered: {question.answerText}
          </Text>
        </VStack>
      </Card>
    );
  }

  return (
    <Card padding={4} variant="orange" maxWidth={640} elevation="low">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon="warning" color="warning" />
          <Text type="label" weight="semibold">
            The agent needs an answer
          </Text>
        </HStack>

        <Text type="body">{question.question}</Text>

        {question.options.length > 0 ? (
          <HStack gap={2} wrap="wrap">
            {question.options.map((option) => (
              <Button
                key={option.id}
                label={option.label}
                variant="secondary"
                size="sm"
                tooltip={option.description}
                isDisabled={isBusy}
                clickAction={() => submit(option.id, null)}
              />
            ))}
          </HStack>
        ) : null}

        {question.allowFreeText ? (
          <HStack gap={2} vAlign="end">
            <TextInput
              label="Your answer"
              value={freeText}
              onChange={setFreeText}
              placeholder="Type an answer…"
              isDisabled={isBusy}
              width="100%"
            />
            <Button
              label="Send"
              variant="primary"
              isDisabled={isBusy || freeText.trim().length === 0}
              clickAction={() => submit(null, freeText.trim())}
            />
          </HStack>
        ) : null}
      </VStack>
    </Card>
  );
}
