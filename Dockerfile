# Farejador - production image

FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/segments ./segments

COPY --from=builder --chown=node:node /app/painel ./painel
COPY --from=builder --chown=node:node /app/parceiro ./parceiro

EXPOSE 3000

USER node

CMD ["node", "dist/app/server.js"]
