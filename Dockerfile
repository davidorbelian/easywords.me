FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/ scripts/
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
ENV NODE_ENV=production PORT=8080 HOME=/tmp
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/dist/web/ dist/web/
COPY src/server/ src/server/
COPY src/shared/ src/shared/
EXPOSE 8080
USER node
CMD ["node", "src/server/main.ts"]
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
