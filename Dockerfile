# Hub image. The Hub never spawns PTYs, so it needs NO node-pty (no native
# build) — just express + ws. node-pty is an optionalDependency and is omitted
# here. This same image also runs the usage service (see docker-compose.yml).
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=optional --no-audit --no-fund

# Only the files the Hub / usage service actually need (no agent.js / sessions.js
# / server.js / node-pty).
COPY hub.js usage-server.js auth.js wire.js ./
COPY usage ./usage
COPY public ./public

ENV NODE_ENV=production HOST=0.0.0.0 PORT=7654 DATA_DIR=/app/data
EXPOSE 7654
CMD ["node", "hub.js"]
