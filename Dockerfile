FROM node:20-alpine

WORKDIR /app

# Copy only runtime files needed by the backend
COPY package.json ./
COPY rag.js ./
COPY backend/server.js ./backend/server.js

# Create writable data directory for cache persistence
RUN mkdir -p /app/backend/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/health || exit 1

CMD ["node", "backend/server.js"]
