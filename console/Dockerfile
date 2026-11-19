# Ziggurat Console. Build from the repository root:
#   docker compose -f console/docker-compose.yml --env-file <your env file> up -d --build
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY console/package.json console/package-lock.json ./
RUN npm ci
COPY console/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client rsync git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY themes/ ./themes/
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ZIGGURAT_THEMES_DIR=/app/themes \
    BODY_SIZE_LIMIT=26214400
# Runs as the image's unprivileged user (uid 1000). Files it pulls land in the
# mounted folders with that owner, so use a host user with the same uid.
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "build"]
