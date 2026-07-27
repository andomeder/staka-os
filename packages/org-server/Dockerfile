FROM oven/bun:1.3.14 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/org-server/package.json packages/org-server/
COPY packages/agent/package.json packages/agent/

RUN bun install --frozen-lockfile

FROM deps AS builder
WORKDIR /app
COPY packages/protocol packages/protocol
COPY packages/org-server packages/org-server
COPY tsconfig.base.json ./

WORKDIR /app/packages/org-server
RUN bun build --compile --minify --sourcemap=none \
  --outfile /out/staka-org-server \
  src/index.ts

FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /
COPY --from=builder /out/staka-org-server /usr/local/bin/staka-org-server
COPY --from=builder /app/packages/org-server/db/migrations /app/db/migrations
USER nonroot:nonroot
EXPOSE 8080
ENV STAKA_MIGRATIONS_DIR=/app/db/migrations
ENTRYPOINT ["/usr/local/bin/staka-org-server"]
