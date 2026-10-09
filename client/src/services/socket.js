import { io } from 'socket.io-client';

// Automatically connects to the host serving the app, or custom VITE_SERVER_URL if frontend is deployed separately
export const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

export const socket = io(SERVER_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity, // keep trying: the room is re-joined automatically on every reconnect
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  transports: ['websocket', 'polling'],
});

// Slide media is stored on the server and referenced by a relative url (/api/media/...)
export function resolveMediaUrl(src) {
  if (!src) return src;
  if (src.startsWith('/api/')) return `${SERVER_URL}${src}`;
  return src;
}
