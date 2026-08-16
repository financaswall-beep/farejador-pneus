# Farejador - production image

FROM node:24-alpine AS builder
WORKDIR /app

# O builder precisa das devDependencies (TypeScript + Tailwind CLI). A imagem
# final redefine NODE_ENV=production e recebe somente os artefatos compilados.
ENV NODE_ENV=development

COPY package*.json ./
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --include=dev

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
# O sharp distribui o binário e o libvips como dependências opcionais específicas
# da plataforma. No Alpine, omiti-las produz uma imagem que compila, mas cai no
# boot com ERR_DLOPEN_FAILED. A prova no build impede publicar essa imagem.
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --include=optional \
    && node -e "require('sharp'); console.log('sharp runtime ok')" \
    && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/segments ./segments

COPY --from=builder --chown=node:node /app/painel ./painel
COPY --from=builder --chown=node:node /app/parceiro ./parceiro

EXPOSE 3000

USER node

CMD ["node", "dist/app/server.js"]
