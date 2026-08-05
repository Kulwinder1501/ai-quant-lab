# Debian rather than Alpine: xgboost, lightgbm, and friends ship manylinux
# wheels only, so a musl-based image would have to compile them from source.
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS builder
COPY package*.json ./
COPY packages/contracts/package*.json ./packages/contracts/
COPY packages/pricing/package*.json ./packages/pricing/
COPY apps/api/package*.json ./apps/api/
COPY apps/web/package*.json ./apps/web/
RUN npm ci || npm install

COPY tsconfig*.json ./
COPY packages/contracts ./packages/contracts
COPY packages/pricing ./packages/pricing
COPY apps/api ./apps/api
RUN npm run build --workspace @ai-quant-lab/api

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Python runtime for the ML pipeline: the scheduler container runs training,
# competition-pool shadow predictions, and pruning via the root npm scripts.
# libgomp1 is the OpenMP runtime xgboost and lightgbm link against.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/venv

COPY apps/ml/requirements.txt ./apps/ml/requirements.txt
COPY apps/ml/requirements-dl.txt ./apps/ml/requirements-dl.txt
# Torch is required so volatility-shadow scoring can run Stage 5/6 sequence
# candidates (TCN / OOF stack). Kept as a separate requirements file so the
# default tree path remains documentable without DL deps.
RUN /opt/venv/bin/pip install --no-cache-dir -r apps/ml/requirements.txt \
  && /opt/venv/bin/pip install --no-cache-dir -r apps/ml/requirements-dl.txt

# scripts/run-python.mjs honors this instead of probing for an interpreter.
ENV PYTHON=/opt/venv/bin/python

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/contracts ./packages/contracts
# Built JavaScript, not source: the API resolves @ai-quant-lab/pricing at runtime.
COPY --from=builder /app/packages/pricing ./packages/pricing
COPY --from=builder /app/apps/api ./apps/api
COPY apps/ml ./apps/ml
COPY scripts ./scripts

EXPOSE 4000
CMD ["sh", "-c", "node apps/api/dist/infrastructure/database/migrate.js && node apps/api/dist/interfaces/cli/seed-core-instruments.js && node apps/api/dist/server.js"]
