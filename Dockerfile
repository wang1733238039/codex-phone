FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data && chown node:node /app/data
COPY src ./src
COPY public ./public
ENV SERVER_CONFIG=/app/data/server.json
USER node
EXPOSE 3819
CMD ["node", "src/server.mjs"]
