FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/cliophate/paper-reader" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0"

ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap util-linux && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY recap ./recap
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /home/node/.codex && chown -R node:node /app /home/node

FROM base AS runtime
ENV HOST=0.0.0.0 PORT=8080 STATE_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist-server/index.js"]

FROM base AS ai
USER root
ARG CODEX_VERSION=0.167.0
RUN npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force
USER node
CMD ["node", "dist-server/ai-worker.js"]
