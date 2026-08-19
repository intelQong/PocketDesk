FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:vendor && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.js"]
