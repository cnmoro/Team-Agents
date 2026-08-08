import type {
  AgentEvent,
  AgentSession,
  AgentSessionWithContext,
  AuthResponse,
  ConversationSummary,
  CreateCredentialInput,
  CreateRepositoryInput,
  CredentialSummary,
  LoginInput,
  MessageWithAuthor,
  Page,
  RegisterInput,
  Repository,
  SendMessageInput,
  StartAgentInput,
  SystemStatus,
  UploadedFile,
  UserPublic,
} from '@teamagents/shared';

/**
 * Typed REST client.
 *
 * Requests are same-origin (Vite proxies /api to the server in development), so
 * the session cookie is sent automatically. The bearer token is also stored and
 * sent as a header, which is what lets the socket handshake authenticate in
 * setups where third-party cookies are blocked.
 */

const TOKEN_KEY = 'teamagents.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const error = payload as { error?: string; message?: string; details?: unknown } | null;
    throw new ApiError(
      response.status,
      error?.error ?? 'error',
      error?.message ?? `Request failed with ${response.status}`,
      error?.details,
    );
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const qs = (params: Record<string, string | number | undefined | null>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

export const api = {
  // --- auth ---------------------------------------------------------------
  register: (input: RegisterInput) => request<AuthResponse>('POST', '/api/auth/register', input),
  login: (input: LoginInput) => request<AuthResponse>('POST', '/api/auth/login', input),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  me: () => request<{ user: UserPublic }>('GET', '/api/auth/me'),

  // --- directory ----------------------------------------------------------
  searchUsers: (params: { query?: string; cursor?: string; limit?: number; conversationId?: string }) =>
    request<Page<UserPublic>>('GET', `/api/users${qs(params)}`),

  // --- conversations ------------------------------------------------------
  listConversations: (params: { cursor?: string; limit?: number } = {}) =>
    request<Page<ConversationSummary>>('GET', `/api/conversations${qs(params)}`),
  getConversation: (id: string) =>
    request<ConversationSummary>('GET', `/api/conversations/${id}`),
  createConversation: (input: { type: 'dm' | 'group'; memberIds: string[]; name?: string }) =>
    request<ConversationSummary>('POST', '/api/conversations', input),
  updateConversation: (
    id: string,
    input: { name?: string; addMemberIds?: string[]; removeMemberIds?: string[] },
  ) => request<ConversationSummary>('PATCH', `/api/conversations/${id}`, input),
  markRead: (id: string) => request<ConversationSummary>('POST', `/api/conversations/${id}/read`),
  leaveConversation: (id: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${id}/leave`),

  // --- messages -----------------------------------------------------------
  listMessages: (conversationId: string, params: { cursor?: string; limit?: number } = {}) =>
    request<Page<MessageWithAuthor>>('GET', `/api/conversations/${conversationId}/messages${qs(params)}`),
  sendMessage: (conversationId: string, input: SendMessageInput) =>
    request<MessageWithAuthor>('POST', `/api/conversations/${conversationId}/messages`, input),
  deleteMessage: (messageId: string) => request<{ ok: true }>('DELETE', `/api/messages/${messageId}`),

  // --- files --------------------------------------------------------------
  uploadFile: (conversationId: string, file: File) => {
    const form = new FormData();
    form.append('conversationId', conversationId);
    form.append('file', file, file.name);
    return request<UploadedFile>('POST', '/api/files', form);
  },
  fileUrl: (fileId: string, download = false) =>
    `/api/files/${fileId}${download ? '?download=1' : ''}`,

  // --- agents -------------------------------------------------------------
  listAgents: (conversationId: string) =>
    request<AgentSession[]>('GET', `/api/conversations/${conversationId}/agents`),
  /** Every session the user can reach, for the settings screen. */
  listAllAgents: () => request<AgentSessionWithContext[]>('GET', '/api/agents'),
  startAgent: (input: StartAgentInput) => request<AgentSession>('POST', '/api/agents', input),
  promptAgent: (id: string, input: { prompt: string; contextMessageIds?: string[] }) =>
    request<AgentSession>('POST', `/api/agents/${id}/prompt`, input),
  answerAgent: (id: string, input: { questionId: string; optionId?: string | null; text?: string | null }) =>
    request<{ ok: true }>('POST', `/api/agents/${id}/answer`, input),
  abortAgent: (id: string) => request<{ ok: true }>('POST', `/api/agents/${id}/abort`),
  closeAgent: (id: string) => request<AgentSession>('DELETE', `/api/agents/${id}`),
  listAgentEvents: (id: string, params: { cursor?: string; limit?: number } = {}) =>
    request<Page<AgentEvent>>('GET', `/api/agents/${id}/events${qs(params)}`),

  // --- credentials & repositories ----------------------------------------
  listCredentials: () => request<Page<CredentialSummary>>('GET', '/api/credentials'),
  createCredential: (input: CreateCredentialInput) =>
    request<CredentialSummary>('POST', '/api/credentials', input),
  deleteCredential: (id: string) => request<{ ok: true }>('DELETE', `/api/credentials/${id}`),
  listRepositories: () => request<Page<Repository>>('GET', '/api/repositories'),
  createRepository: (input: CreateRepositoryInput) =>
    request<Repository>('POST', '/api/repositories', input),
  /** `force` overrides the guard that refuses while an agent session holds it. */
  deleteRepository: (id: string, force = false) =>
    request<{ ok: true }>('DELETE', `/api/repositories/${id}${force ? '?force=1' : ''}`),

  // --- system -------------------------------------------------------------
  systemStatus: () => request<SystemStatus>('GET', '/api/system/status'),
};
