# Stage 1: Build React client
FROM --platform=$BUILDPLATFORM node:24-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
ENV IBM_TELEMETRY_DISABLED=true
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Build TypeScript server
FROM --platform=$BUILDPLATFORM node:24-alpine AS server-builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build:server

# Stage 3: Production image
FROM node:24-alpine AS production
WORKDIR /app
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
COPY package*.json ./
# no build toolchain: better-sqlite3 ships its musl prebuilds; package.json
# allowScripts denies its implicit node-gyp step
RUN npm ci --omit=dev
COPY --from=server-builder /app/dist ./dist
COPY --from=client-builder /app/client/dist ./client/dist
COPY airports.json ./
COPY airport-tiers.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
