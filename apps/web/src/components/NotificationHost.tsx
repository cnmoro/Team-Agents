import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { useChat } from '../state/ChatContext.js';

/**
 * Turns incoming-message notifications into toasts.
 *
 * The store owns the notification queue (it also feeds the browser's native
 * Notification API when the tab is hidden); this component is only responsible
 * for surfacing each one once and letting the user jump straight to the chat.
 */
export function NotificationHost(): ReactNode {
  const { notifications, dismissNotification, selectConversation } = useChat();
  const toast = useToast();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    for (const notification of notifications) {
      if (shown.current.has(notification.id)) continue;
      shown.current.add(notification.id);

      toast({
        uniqueID: notification.id,
        type: notification.isUrgent ? 'error' : 'info',
        // Mentions and agent questions stay until acknowledged; ordinary
        // messages fade on their own.
        isAutoHide: !notification.isUrgent,
        body: (
          <VStack gap={1}>
            <Text type="label" weight="semibold">
              {notification.title}
            </Text>
            <Text type="supporting" maxLines={3}>
              {notification.body}
            </Text>
          </VStack>
        ),
        endContent: (
          <HStack gap={1}>
            <Button
              label="Open"
              size="sm"
              variant="ghost"
              onClick={() => {
                selectConversation(notification.conversationId);
                dismissNotification(notification.id);
              }}
            />
          </HStack>
        ),
        onHide: () => dismissNotification(notification.id),
      });
    }

    // Keep the guard set from growing without bound in a long-lived tab.
    if (shown.current.size > 500) shown.current = new Set(notifications.map((n) => n.id));
  }, [notifications, toast, dismissNotification, selectConversation]);

  return null;
}
