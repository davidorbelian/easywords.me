FROM mcr.microsoft.com/playwright:v1.59.1-noble@sha256:b0ab6f3cb99aa7803adbc14d9027ec1785fc6e433b97e134e0f8fe61683b6b53
WORKDIR /runner
RUN npm install --save-exact @playwright/test@1.59.1
ENV NODE_PATH=/runner/node_modules
WORKDIR /work
ENTRYPOINT ["/runner/node_modules/.bin/playwright"]
