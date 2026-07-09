# Stage 1: Build admin web UI
FROM node:20-alpine AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build liveshare web page
FROM node:20-alpine AS live-builder
WORKDIR /live
COPY live/package.json live/package-lock.json ./
RUN npm ci
COPY live/ ./
RUN npm run build

# Stage 3: Build server
FROM node:20-alpine AS server-builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 4: Final image
FROM node:20-alpine
WORKDIR /app
COPY --from=server-builder /app/dist ./dist
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/package.json ./
COPY --from=web-builder /web/dist ./web/dist
COPY --from=live-builder /live/dist ./live/dist
RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
