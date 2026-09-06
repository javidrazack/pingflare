FROM node:22-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
COPY frontend/package*.json ./frontend/
RUN npm ci --ignore-scripts
COPY locales/ ./locales/
COPY frontend/ ./frontend/
RUN npm run build -w frontend

FROM node:22-alpine AS server-builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
COPY frontend/package*.json ./frontend/
RUN npm ci
COPY src/ ./src/
COPY locales/ ./locales/
COPY tsconfig.json ./
COPY tsup.config.ts ./
RUN npm run build:server
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/dist-server ./dist-server
COPY --from=frontend-builder /app/frontend/build ./frontend/build

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/pingflare.db

CMD ["node", "dist-server/server.js"]
