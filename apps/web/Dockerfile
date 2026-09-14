FROM node:22-alpine AS base
WORKDIR /app

FROM base AS builder
COPY package*.json ./
COPY packages/contracts/package*.json ./packages/contracts/
COPY packages/pricing/package*.json ./packages/pricing/
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/
RUN npm ci

COPY tsconfig*.json ./
COPY packages/contracts ./packages/contracts
COPY packages/pricing ./packages/pricing
COPY apps/web ./apps/web
# Next.js inlines NEXT_PUBLIC_* into the client bundle during the build, so this has
# to be a build arg. Setting it only at runtime in compose is too late to have any
# effect, which silently pointed every image at the default API port.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace @ai-quant-lab/web

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
# Built JavaScript, not source: the API resolves @ai-quant-lab/pricing at runtime.
COPY --from=builder /app/packages/pricing ./packages/pricing
COPY --from=builder /app/apps/web ./apps/web

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@ai-quant-lab/web"]
