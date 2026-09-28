# R14 deployment image. Build: docker build -t crm-sync .
# Secrets (DATABASE_URL, DATABASE_MIGRATION_URL, APP_ENCRYPTION_KEY, ...) come from the
# runtime environment / secret manager -- never from the image (see .dockerignore).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db/migrations ./db/migrations
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Web process; run the same image with `node dist/worker.js` for workers and
# `node dist/db/migrate.js` as the release (migration) step.
CMD ["node", "dist/server.js"]
