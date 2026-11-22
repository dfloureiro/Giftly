# syntax=docker/dockerfile:1
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

RUN apk add --no-cache su-exec

WORKDIR /app
# No npm dependencies: only the app itself is copied.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
