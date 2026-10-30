FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Extracted-text cache and snapshot DB live in volumes (the root filesystem is read-only).
RUN mkdir -p /cache /data && chown node:node /cache /data
ENV CACHE_DIR=/cache DB_PATH=/data/canvas.db
USER node
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/cli.js", "--http"]
