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
COPY apps/web ./apps/web
ENV NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
RUN npm run build --workspace @ai-quant-lab/web

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
COPY --from=builder /app/apps/web ./apps/web

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@ai-quant-lab/web"]
