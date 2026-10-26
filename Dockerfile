# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

# Copy manifests only – maximises layer-cache hits
COPY package.json package-lock.json* ./

# Install production deps only; skip ffmpeg-static's post-install download
# (we use the system ffmpeg instead)
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# Heavy layer — cached independently so adding small packages never busts it
RUN apk add --no-cache ffmpeg
# Each package in its own layer — changing one never re-runs the others
RUN apk add --no-cache su-exec
RUN apk add --no-cache python3

WORKDIR /app

# node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Application source
COPY index.js security.js package.json ./
COPY public ./public

# yt-dlp Python zipapp — architecture-agnostic, works on arm64 and amd64
COPY bin/yt-dlp /usr/local/bin/yt-dlp
RUN chmod 755 /usr/local/bin/yt-dlp

# Point the app at system binaries
ENV FFMPEG_BIN=/usr/bin/ffmpeg
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 3009

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
 && chown -R appuser:appgroup /app

# Entrypoint runs as root so it can fix volume permissions, then drops to appuser
ENTRYPOINT ["/app/entrypoint.sh"]
