FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.server.json tsconfig.server.build.json ./
COPY server ./server
COPY shared ./shared
RUN npm run build:server

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/vortex-learning.sqlite \
    RESOURCE_STORAGE_PATH=/data/resources
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
CMD ["node", "dist-server/server/index.js"]
