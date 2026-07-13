# OpenLogTool Server WebUI

React + Ant Design portal for the authenticated member workspace (`/app`) and
server administration console (`/admin`). The app uses an in-memory access
token and an HttpOnly refresh cookie through `/api/v1/web-auth/*`.

```bash
npm install
npm run dev
npm run lint
npm run build
```

The development server proxies `/api` to `http://localhost:3000`.
Production refresh cookies are `Secure`; expose the portal through HTTPS (or a
browser-recognized localhost development origin), not plaintext LAN HTTP.

## Authentication contract

- Access tokens live only in JavaScript memory.
- `/api/v1/web-auth/refresh` rotates an HttpOnly, SameSite refresh cookie.
- Concurrent `401` responses share one refresh request; tabs coordinate through
  the Web Locks API when available, and a freshly rotated cookie is retried once
  using the server-provided delay.
- Web authentication sends a stable browser device ID so rotated credentials
  remain one revocable device-session family.
- `PASSWORD_CHANGE_REQUIRED` is completed with a short-lived password-change
  token before an access token is issued.
- Administrator elevation tokens live only in memory and are attached for at
  most five minutes to governance requests.

The public Liveshare remains a separate bundle and must never share this
authenticated client's token or cookie state.
