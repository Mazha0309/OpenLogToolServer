# Stage 1: Build the member and administrator Web portal
FROM node:24.18.0-bookworm AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --jobs=1
COPY web/ ./
RUN npm run build

# Stage 2: Build secure public Liveshare UI
FROM node:24.18.0-bookworm AS live-builder
WORKDIR /live
COPY live/package.json live/package-lock.json ./
RUN npm ci --jobs=1
COPY live/ ./
RUN npm run build

# Stage 3: Build server
FROM node:24.18.0-bookworm AS server-builder
ENV MAKEFLAGS="-j1"
ENV npm_config_jobs=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --jobs=1
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# Stage 4: Final image
FROM node:24.18.0-bookworm-slim
WORKDIR /app
COPY --from=server-builder /app/dist ./dist
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/package.json ./
COPY --from=web-builder /web/dist ./web/dist
COPY --from=live-builder /live/dist ./live/dist
RUN mkdir -p /app/data && chown node:node /app/data

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/server-info').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
