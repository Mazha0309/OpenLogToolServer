FROM node:18-alpine AS base
WORKDIR /app

FROM base AS builder
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .

FROM base AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/src ./src
COPY --from=web-builder /app/web/dist ./web/dist

EXPOSE 3000

CMD ["node", "server/index.js"]