# Jhola service: Node + Chromium (headless) + web UI + scheduler + history.
# Build:  docker compose build      Run: docker compose up -d
FROM node:24-slim

# Chromium for the engine's warm headless browser, fonts so pages lay out,
# tini as PID 1 so Chrome child processes are reaped, tzdata for schedules.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-color-emoji tini tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    JHOLA_CHROME_NO_SANDBOX=1 \
    JHOLA_HOME=/data \
    JHOLA_HOST=0.0.0.0 \
    JHOLA_PORT=7777 \
    TZ=Asia/Kolkata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY basket.txt ./

# Run as the unprivileged "node" user (uid 1000); /data holds config,
# history (basket.db), results/ and the Chrome profile (sessions, location).
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7777/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/cli.js", "serve"]
