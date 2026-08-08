# Backend de reuniões do chatPro.
#
# NÃO roda em Vercel/Netlify (serverless): é um servidor sempre-ativo, com fila
# em segundo plano e banco em disco. Precisa de processo contínuo + volume.
#
# Duas etapas pra imagem final não carregar o compilador nem as devDeps.

# ─── Etapa 1: compilar ───────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY server/package*.json ./
# --include=optional aqui não: o TypeScript compila sem as pesadas, porque elas
# são carregadas por import dinâmico.
RUN npm ci --omit=optional

COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ─── Etapa 2: rodar ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim
WORKDIR /app

# curl só pro HEALTHCHECK abaixo.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
# Sem devDeps e sem as opcionais: @xenova/transformers (~45 MB) e ffmpeg-static
# (~80 MB) só servem ao caminho antigo de captura de áudio. Com o Recall a
# transcrição já vem pronta — são 125 MB que a imagem não precisa carregar.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --from=build /app/dist ./dist

# O banco vive no volume. Sem montar /dados, cada deploy perde as reuniões.
ENV NODE_ENV=production \
    PORT=3333 \
    DATABASE_PATH=/dados/app.db \
    STT_PROVIDER=none
VOLUME ["/dados"]
EXPOSE 3333

# O provedor reinicia o container quando isto falha. /api/health é livre de
# propósito (não passa pela tranca do painel).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "dist/index.js"]
