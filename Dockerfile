# Sentinal MT5 — one image serving the API, the WebSocket feed and the terminal.
# With METAAPI_TOKEN set it trades your MetaTrader accounts around the clock.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY mql5/package.json mql5/
COPY engine/package.json engine/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY mql5/package.json mql5/
COPY engine/package.json engine/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace shared --workspace mql5 --workspace engine --workspace server

COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/mql5/dist mql5/dist
COPY --from=build /app/engine/dist engine/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# The uploaded strategy, settings and EA global variables live here; mount a
# volume on it to keep them across deploys.
ENV STATE_DIR=/data
VOLUME /data

EXPOSE 4000
ENV PORT=4000 HOST=0.0.0.0
CMD ["node", "server/dist/index.js"]
