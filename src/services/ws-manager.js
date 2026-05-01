import { WebSocketServer } from 'ws';

class WsManager {
  constructor() {
    this.wss = null;
    this.rooms = new Map();
  }

  init(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const deviceId = url.searchParams.get('deviceId');

      if (!sessionId) {
        ws.close();
        return;
      }

      if (!this.rooms.has(sessionId)) {
        this.rooms.set(sessionId, new Set());
      }
      this.rooms.get(sessionId).add(ws);

      ws.on('close', () => {
        const room = this.rooms.get(sessionId);
        if (room) {
          room.delete(ws);
          if (room.size === 0) this.rooms.delete(sessionId);
        }
      });
    });
  }

  broadcast(sessionId, message, excludeDeviceId = null) {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const ws of room) {
      if (ws.readyState === 1) ws.send(data);
    }
  }
}

export const wsManager = new WsManager();
