FROM node:18-bookworm-slim as builder

WORKDIR /builder

COPY package*.json ./

RUN npm ci --omit dev
# RUN npm install

FROM node:18-bookworm-slim as final

ENV PORT=8081
ENV ENABLE_CACHE=false
ENV CACHE_TTL=300000
ENV BACKEND_SERVER_LIST=http://localhost:3000,http://localhost:3001
ENV ROUND_ROBIN_STRATEGY=sequential

ARG APP_USER=node

WORKDIR /app

COPY --from=builder --chown=$APP_USER:$APP_USER /builder/node_modules /app/node_modules

COPY --chown=$APP_USER:$APP_USER . .

USER $APP_USER

EXPOSE $PORT

ENTRYPOINT ["node", "src/index.mjs"]