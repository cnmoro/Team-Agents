import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgentEvent,
  AgentSession,
  ConversationSummary,
  MessageWithAuthor,
  SendMessageInput,
  StartAgentInput,
  UserPublic,
} from '@teamagents/shared';
import { api } from '../lib/api.js';
import { connectSocket, disconnectSocket, type AppSocket } from '../lib/socket.js';
import { useAuth } from './AuthContext.js';

interface MessagePage {
  items: MessageWithAuthor[];
  nextCursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  isLoaded: boolean;
}

const EMPTY_PAGE: MessagePage = {
  items: [],
  nextCursor: null,
  hasMore: false,
  isLoading: false,
  isLoaded: false,
};

export interface ChatNotification {
  id: string;
  conversationId: string;
  title: string;
  body: string;
  /** True for mentions and agent questions, which get a louder treatment. */
  isUrgent: boolean;
}

interface ChatContextValue {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversation: ConversationSummary | null;
  messages: MessagePage;
  agents: AgentSession[];
  onlineUserIds: Set<string>;
  typingUsers: UserPublic[];
  notifications: ChatNotification[];
  isConnected: boolean;

  selectConversation: (id: string | null) => void;
  loadOlderMessages: () => Promise<void>;
  sendMessage: (input: SendMessageInput) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  createConversation: (input: {
    type: 'dm' | 'group';
    memberIds: string[];
    name?: string;
  }) => Promise<ConversationSummary>;
  refreshConversations: () => Promise<void>;

  startAgent: (input: Omit<StartAgentInput, 'conversationId'>) => Promise<AgentSession>;
  promptAgent: (agentId: string, prompt: string, contextMessageIds?: string[]) => Promise<void>;
  answerAgent: (
    agentId: string,
    input: { questionId: string; optionId?: string | null; text?: string | null },
  ) => Promise<void>;
  abortAgent: (agentId: string) => Promise<void>;
  closeAgent: (agentId: string) => Promise<void>;

  traceFor: (agentId: string) => AgentEvent[];
  loadTrace: (agentId: string) => Promise<void>;

  setTyping: (isTyping: boolean) => void;
  dismissNotification: (id: string) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }): ReactNode {
  const { user } = useAuth();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, MessagePage>>({});
  const [agentsByConversation, setAgentsByConversation] = useState<Record<string, AgentSession[]>>({});
  const [traceByAgent, setTraceByAgent] = useState<Record<string, AgentEvent[]>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [typingByConversation, setTypingByConversation] = useState<Record<string, UserPublic[]>>({});
  const [notifications, setNotifications] = useState<ChatNotification[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const socketRef = useRef<AppSocket | null>(null);
  // Socket handlers are registered once per session, so anything they read from
  // state has to come through a ref or they would see the values from the
  // render that installed them.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeConversationId;
  const conversationsRef = useRef<ConversationSummary[]>([]);
  conversationsRef.current = conversations;

  // --- initial load -------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    const page = await api.listConversations({ limit: 50 });
    setConversations(page.items);
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshConversations();
  }, [user, refreshConversations]);

  // --- socket wiring ------------------------------------------------------

  useEffect(() => {
    if (!user) {
      disconnectSocket();
      socketRef.current = null;
      return;
    }

    const socket = connectSocket();
    socketRef.current = socket;

    const upsertConversation = (conversation: ConversationSummary) =>
      setConversations((previous) => {
        const next = previous.some((c) => c.id === conversation.id)
          ? previous.map((c) => (c.id === conversation.id ? conversation : c))
          : [conversation, ...previous];
        // Keep the sidebar ordered by recency, exactly as the API returns it.
        return [...next].sort(
          (a, b) =>
            new Date(b.lastMessageAt ?? b.createdAt).getTime() -
            new Date(a.lastMessageAt ?? a.createdAt).getTime(),
        );
      });

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('presence:sync', ({ userIds }) => setOnlineUserIds(new Set(userIds)));
    socket.on('presence', ({ userId, online }) =>
      setOnlineUserIds((previous) => {
        const next = new Set(previous);
        if (online) next.add(userId);
        else next.delete(userId);
        return next;
      }),
    );

    socket.on('message:new', ({ message, conversation }) => {
      upsertConversation(conversation);

      setMessagesByConversation((previous) => {
        const page = previous[message.conversationId];
        // Only append to histories already loaded; an unopened conversation
        // will fetch its own page when it is selected.
        if (!page?.isLoaded) return previous;
        if (page.items.some((existing) => existing.id === message.id)) return previous;
        return {
          ...previous,
          [message.conversationId]: { ...page, items: [...page.items, message] },
        };
      });

      const isActive = activeIdRef.current === message.conversationId;
      const isOwn = message.author.kind === 'user' && message.author.userId === user.id;

      if (isActive && !document.hidden) {
        // Reading it as it arrives: keep the read marker current.
        void api.markRead(message.conversationId).then(upsertConversation).catch(() => {});
      } else if (!isOwn && message.kind !== 'system') {
        notify(message, conversation);
      }
    });

    socket.on('message:update', ({ message }) => {
      setMessagesByConversation((previous) => {
        const page = previous[message.conversationId];
        if (!page?.isLoaded) return previous;
        return {
          ...previous,
          [message.conversationId]: {
            ...page,
            items: page.items.map((item) => (item.id === message.id ? message : item)),
          },
        };
      });
    });

    socket.on('message:delete', ({ conversationId, messageId }) => {
      setMessagesByConversation((previous) => {
        const page = previous[conversationId];
        if (!page?.isLoaded) return previous;
        return {
          ...previous,
          [conversationId]: {
            ...page,
            items: page.items.filter((item) => item.id !== messageId),
          },
        };
      });
    });

    socket.on('conversation:update', ({ conversation }) => upsertConversation(conversation));
    socket.on('conversation:new', ({ conversation }) => upsertConversation(conversation));

    socket.on('agent:session', ({ session }) => {
      setAgentsByConversation((previous) => {
        const list = previous[session.conversationId] ?? [];
        const next = list.some((s) => s.id === session.id)
          ? list.map((s) => (s.id === session.id ? session : s))
          : [...list, session];
        return { ...previous, [session.conversationId]: next };
      });
    });

    socket.on('agent:event', ({ event }) => {
      setTraceByAgent((previous) => {
        const existing = previous[event.agentSessionId];
        // Only grow traces the user has actually opened; the rest are fetched
        // on demand, and buffering every event for every agent would leak.
        if (!existing) return previous;
        if (existing.some((e) => e.seq === event.seq)) return previous;
        return {
          ...previous,
          [event.agentSessionId]: [...existing, event].sort((a, b) => a.seq - b.seq),
        };
      });
    });

    socket.on('agent:question', ({ conversationId, question }) => {
      const conversation = conversationsRef.current.find((c) => c.id === conversationId);
      pushNotification({
        id: question.questionId,
        conversationId,
        title: conversation ? `${conversation.title} — agent needs you` : 'An agent needs you',
        body: question.question,
        isUrgent: true,
      });
    });

    socket.on('typing', ({ conversationId, user: who, typing }) => {
      setTypingByConversation((previous) => {
        const current = previous[conversationId] ?? [];
        const next = typing
          ? current.some((u) => u.id === who.id)
            ? current
            : [...current, who]
          : current.filter((u) => u.id !== who.id);
        return { ...previous, [conversationId]: next };
      });
    });

    return () => {
      socket.removeAllListeners();
    };
    // Deliberately keyed on the signed-in user alone: re-registering every
    // listener whenever the sidebar changes would drop in-flight events. State
    // the handlers need is read through refs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // --- notifications ------------------------------------------------------

  const pushNotification = useCallback((notification: ChatNotification) => {
    setNotifications((previous) => [...previous.filter((n) => n.id !== notification.id), notification]);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      // The browser notification only fires when the tab is in the background;
      // in-app toasts cover the foreground case.
      new Notification(notification.title, { body: notification.body.slice(0, 200) });
    }
  }, []);

  const notify = useCallback(
    (message: MessageWithAuthor, conversation: ConversationSummary) => {
      const author = message.authorUser?.displayName ?? 'Agent';
      const preview = message.blocks
        .map((block) =>
          block.type === 'text'
            ? block.text
            : block.type === 'code'
              ? `[${block.language} snippet]`
              : block.type === 'image'
                ? '[image]'
                : `[${block.filename}]`,
        )
        .join(' ')
        .slice(0, 180);
      pushNotification({
        id: message.id,
        conversationId: message.conversationId,
        title: conversation.type === 'group' ? `${author} in ${conversation.title}` : author,
        body: preview,
        isUrgent: Boolean(user && message.mentions.includes(user.id)),
      });
    },
    [pushNotification, user],
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((previous) => previous.filter((n) => n.id !== id));
  }, []);

  // Asks once, on first mount, so background notifications can be delivered.
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') void Notification.requestPermission();
  }, []);

  // --- conversation selection --------------------------------------------

  const loadMessages = useCallback(async (conversationId: string) => {
    setMessagesByConversation((previous) => ({
      ...previous,
      [conversationId]: { ...(previous[conversationId] ?? EMPTY_PAGE), isLoading: true },
    }));

    const page = await api.listMessages(conversationId, { limit: 20 });
    setMessagesByConversation((previous) => ({
      ...previous,
      [conversationId]: {
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        isLoading: false,
        isLoaded: true,
      },
    }));
  }, []);

  const selectConversation = useCallback(
    (id: string | null) => {
      setActiveConversationId(id);
      if (!id) return;

      socketRef.current?.emit('conversation:subscribe', { conversationId: id });
      // Clear the unread highlight immediately; the server confirms and pushes
      // the corrected summary back.
      setConversations((previous) =>
        previous.map((c) => (c.id === id ? { ...c, unreadCount: 0, hasMention: false } : c)),
      );
      setNotifications((previous) => previous.filter((n) => n.conversationId !== id));

      void api
        .markRead(id)
        .then((conversation) =>
          setConversations((previous) =>
            previous.map((c) => (c.id === conversation.id ? conversation : c)),
          ),
        )
        .catch(() => {});

      if (!messagesByConversation[id]?.isLoaded) void loadMessages(id);
      void api
        .listAgents(id)
        .then((sessions) => setAgentsByConversation((previous) => ({ ...previous, [id]: sessions })))
        .catch(() => {});
    },
    [loadMessages, messagesByConversation],
  );

  const loadOlderMessages = useCallback(async () => {
    const id = activeConversationId;
    if (!id) return;
    const page = messagesByConversation[id];
    if (!page?.hasMore || page.isLoading || !page.nextCursor) return;

    setMessagesByConversation((previous) => ({
      ...previous,
      [id]: { ...previous[id]!, isLoading: true },
    }));

    const older = await api.listMessages(id, { cursor: page.nextCursor, limit: 20 });
    setMessagesByConversation((previous) => {
      const current = previous[id]!;
      const known = new Set(current.items.map((m) => m.id));
      return {
        ...previous,
        [id]: {
          ...current,
          items: [...older.items.filter((m) => !known.has(m.id)), ...current.items],
          nextCursor: older.nextCursor,
          hasMore: older.hasMore,
          isLoading: false,
        },
      };
    });
  }, [activeConversationId, messagesByConversation]);

  // --- actions ------------------------------------------------------------

  const sendMessage = useCallback(
    async (input: SendMessageInput) => {
      const id = activeConversationId;
      if (!id) return;
      const message = await api.sendMessage(id, input);
      // The socket echo usually lands first; this covers the case where it does
      // not, and de-duplicates on id either way.
      setMessagesByConversation((previous) => {
        const page = previous[id];
        if (!page?.isLoaded || page.items.some((m) => m.id === message.id)) return previous;
        return { ...previous, [id]: { ...page, items: [...page.items, message] } };
      });
    },
    [activeConversationId],
  );

  const deleteMessage = useCallback(async (messageId: string) => {
    await api.deleteMessage(messageId);
    // The socket echo removes it for everyone, including this tab, but dropping
    // it here too keeps the click feeling instant.
    setMessagesByConversation((previous) => {
      const next: Record<string, MessagePage> = {};
      for (const [conversationId, page] of Object.entries(previous)) {
        next[conversationId] = {
          ...page,
          items: page.items.filter((item) => item.id !== messageId),
        };
      }
      return next;
    });
  }, []);

  const createConversation = useCallback(
    async (input: { type: 'dm' | 'group'; memberIds: string[]; name?: string }) => {
      const conversation = await api.createConversation(input);
      setConversations((previous) =>
        previous.some((c) => c.id === conversation.id)
          ? previous.map((c) => (c.id === conversation.id ? conversation : c))
          : [conversation, ...previous],
      );
      return conversation;
    },
    [],
  );

  const startAgent = useCallback(
    async (input: Omit<StartAgentInput, 'conversationId'>) => {
      const id = activeConversationId;
      if (!id) throw new Error('Open a conversation first');
      const session = await api.startAgent({ ...input, conversationId: id });
      // The socket announcement usually beats this response, so the session may
      // already be in the list; appending blindly would duplicate the card.
      setAgentsByConversation((previous) => {
        const list = previous[id] ?? [];
        return {
          ...previous,
          [id]: list.some((existing) => existing.id === session.id)
            ? list.map((existing) => (existing.id === session.id ? session : existing))
            : [...list, session],
        };
      });
      return session;
    },
    [activeConversationId],
  );

  const promptAgent = useCallback(
    async (agentId: string, prompt: string, contextMessageIds?: string[]) => {
      await api.promptAgent(agentId, { prompt, contextMessageIds });
    },
    [],
  );

  const answerAgent = useCallback(
    async (
      agentId: string,
      input: { questionId: string; optionId?: string | null; text?: string | null },
    ) => {
      await api.answerAgent(agentId, input);
      setNotifications((previous) => previous.filter((n) => n.id !== input.questionId));
    },
    [],
  );

  const abortAgent = useCallback(async (agentId: string) => {
    await api.abortAgent(agentId);
  }, []);

  const closeAgent = useCallback(async (agentId: string) => {
    const session = await api.closeAgent(agentId);
    setAgentsByConversation((previous) => ({
      ...previous,
      [session.conversationId]: (previous[session.conversationId] ?? []).map((s) =>
        s.id === session.id ? session : s,
      ),
    }));
  }, []);

  const loadTrace = useCallback(async (agentId: string) => {
    const page = await api.listAgentEvents(agentId, { limit: 100 });
    setTraceByAgent((previous) => ({ ...previous, [agentId]: page.items }));
  }, []);

  const traceFor = useCallback(
    (agentId: string): AgentEvent[] => traceByAgent[agentId] ?? [],
    [traceByAgent],
  );

  const setTyping = useCallback(
    (isTyping: boolean) => {
      const id = activeConversationId;
      if (!id) return;
      socketRef.current?.emit('typing', { conversationId: id, typing: isTyping });
    },
    [activeConversationId],
  );

  // --- derived ------------------------------------------------------------

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const messages = activeConversationId
    ? (messagesByConversation[activeConversationId] ?? EMPTY_PAGE)
    : EMPTY_PAGE;

  const agents = activeConversationId ? (agentsByConversation[activeConversationId] ?? []) : [];

  const typingUsers = useMemo(
    () =>
      (activeConversationId ? (typingByConversation[activeConversationId] ?? []) : []).filter(
        (u) => u.id !== user?.id,
      ),
    [typingByConversation, activeConversationId, user],
  );

  const value: ChatContextValue = {
    conversations,
    activeConversationId,
    activeConversation,
    messages,
    agents,
    onlineUserIds,
    typingUsers,
    notifications,
    isConnected,
    selectConversation,
    loadOlderMessages,
    sendMessage,
    deleteMessage,
    createConversation,
    refreshConversations,
    startAgent,
    promptAgent,
    answerAgent,
    abortAgent,
    closeAgent,
    traceFor,
    loadTrace,
    setTyping,
    dismissNotification,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used inside a ChatProvider');
  return context;
}
