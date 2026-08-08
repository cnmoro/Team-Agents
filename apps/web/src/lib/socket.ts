import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@teamagents/shared';
import { getToken } from './api.js';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

/**
 * One socket per browser tab, created lazily after login.
 *
 * The token is passed through the handshake `auth` payload as well as the
 * cookie so the connection authenticates even where cookies are restricted.
 */
export function connectSocket(): AppSocket {
  if (socket?.connected) return socket;
  socket?.close();

  socket = io({
    path: '/socket.io',
    withCredentials: true,
    auth: { token: getToken() },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  }) as AppSocket;

  return socket;
}

export function getSocket(): AppSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.close();
  socket = null;
}
