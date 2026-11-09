FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/cliophate/paper-reader" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0-alpha.2"

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATE_DIR=/data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY recap ./recap
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /data /home/node/.local/share/opencode /home/node/.codex && chown -R node:node /app /data /home/node/.local /home/node/.codex
USER node
EXPOSE 8080
CMD ["node", "dist-server/index.js"]

FROM runtime AS ai
USER root
ARG CODEX_VERSION=0.167.0
ARG OPENCODE_VERSION=1.19.5
RUN npm install --global @openai/codex@${CODEX_VERSION} opencode-ai@${OPENCODE_VERSION} && npm cache clean --force
USER node
