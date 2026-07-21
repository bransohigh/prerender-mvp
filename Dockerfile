# Build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

# Remove dev dependencies
RUN npm prune --production

# Production stage — Playwright base with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS production
WORKDIR /app

# Copy production artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Migration SQL files are read directly at runtime by drizzle-orm's
# migrator (scripts/db/migrate.ts), not compiled — must ship alongside dist.
COPY drizzle ./drizzle

# Create writable directories for Chromium temp profiles
RUN mkdir -p /tmp/chromium-profile /tmp/playwright && \
    chown -R pwuser:pwuser /tmp/chromium-profile /tmp/playwright /app

ENV NODE_ENV=production
ENV TMPDIR=/tmp
ENV HOME=/home/pwuser

# Switch to non-root user (pwuser is UID 1000 in Playwright image)
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
