import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const rooms = new Map<string, Set<WebSocket>>();

export function createWsServer(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) { ws.close(4000, 'Missing sessionId'); return; }
    if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
    rooms.get(sessionId)!.add(ws);
    ws.on('close', () => {
      rooms.get(sessionId)?.delete(ws);
      if (rooms.get(sessionId)?.size === 0) rooms.delete(sessionId);
    });
  });
}

export function broadcast(sessionId: string, message: object) {
  const clients = rooms.get(sessionId);
  if (!clients) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
