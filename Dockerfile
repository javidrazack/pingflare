FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY package.json /app/package.json
COPY locales/ /app/locales/
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

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
