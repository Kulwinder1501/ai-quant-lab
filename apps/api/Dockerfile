FROM node:20-alpine AS base
WORKDIR /app

FROM base AS builder
COPY package*.json ./
COPY packages/contracts/package*.json ./packages/contracts/
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/
RUN npm ci || npm install

COPY tsconfig*.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN npm run build --workspace @ai-quant-lab/api

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/apps/api ./apps/api

EXPOSE 4000
CMD ["sh", "-c", "node apps/api/dist/infrastructure/database/migrate.js && node apps/api/dist/interfaces/cli/seed-core-instruments.js && node apps/api/dist/server.js"]
