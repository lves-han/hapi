FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:web && bun run --cwd hub generate:embedded-web-assets && bun run build:hub

FROM oven/bun:1.4.0
WORKDIR /app
COPY --from=build /app/hub/dist /app/hub/dist
COPY --from=build /app/web/dist /app/web/dist
ENV HAPI_LISTEN_HOST=0.0.0.0 HAPI_LISTEN_PORT=3006
EXPOSE 3006
CMD ["bun", "run", "hub/dist/index.js"]
