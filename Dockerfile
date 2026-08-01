# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:24-slim AS build

WORKDIR /app

# Install deps first so the layer caches across source changes.
COPY package.json package-lock.json ./
# --ignore-scripts also skips ffmpeg-static's postinstall binary download,
# which would fetch ~80MB we then discard: the runtime stage uses apt's ffmpeg.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
# tsc directly, not `npm run build`: that script regenerates the widget bundles
# with esbuild, whose platform binary is not reliably present under
# --ignore-scripts. src/widgets.generated.ts is committed for exactly this
# reason — regenerate it locally with `npm run build:widgets`.
RUN npx tsc -p tsconfig.json

# Reinstall as production-only for the runtime stage.
RUN npm ci --omit=dev --ignore-scripts

# -------------------------------------------------------------- runtime stage
FROM node:24-slim AS runtime

# The real ffmpeg, from the distro. Frame extraction is a hard requirement —
# the server refuses to boot without a working binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Don't run as root.
USER node

# Render (and most hosts) inject PORT; config.ts reads it, defaulting to 3000.
EXPOSE 3000

CMD ["node", "dist/index.js"]
