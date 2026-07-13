# OpenLogTool secure Liveshare

The public, read-only Liveshare client for collaboration protocol v1.

It expects to be mounted as an SPA at `/live` and opened with a capability URL:

```text
/live/{publicShareId}#token={secret}
```

The fragment secret is removed from browser history immediately and stays only in memory. The client checks `server-info`, exchanges the secret for a short-lived public token, fetches a full public snapshot, then connects to `/ws/public` with a one-time ticket. WebSocket data is accepted only in `hello -> backlog -> ready -> live` order; a sequence gap triggers a new snapshot.

```bash
npm run dev
npm run lint
npm run build
```

The Express server must mount `dist` at `/live` with an SPA fallback to `dist/index.html`. Vite's production asset base is `/live/`.
