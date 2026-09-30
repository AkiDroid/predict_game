# syntax=docker/dockerfile:1

FROM node:22.17-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci
COPY . .
RUN npm run build && test -f dist/index.html

FROM node:22.17-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    SERVE_STATIC=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev \
    && npm install -g tsx@4.23.15 \
    && command -v tsx \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/backend ./backend
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY deploy/entrypoint.sh /app/entrypoint.sh
COPY deploy/backup.mjs /app/backup.mjs
RUN chmod 755 /app/entrypoint.sh
EXPOSE 5173
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["serve"]
