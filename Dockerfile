# Backend de transcrição chatPro — imagem para hospedagem (Railway/Render/Fly/VPS).
# NÃO funciona em Vercel/Netlify (serverless): este servidor é sempre-ativo,
# grava arquivos em disco e roda filas em segundo plano.
FROM node:20-bookworm

WORKDIR /app

# Instala dependências (inclui devDeps para compilar o TypeScript).
COPY server/package*.json ./
RUN npm ci

# Copia o código e compila.
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# Dados persistentes: banco SQLite, áudios capturados e cache do modelo Whisper.
# Monte um volume em /data no seu provedor para não perder nada em cada deploy.
ENV NODE_ENV=production \
    PORT=3333 \
    DATABASE_PATH=/data/app.db \
    STT_PROVIDER=local \
    STT_LANGUAGE=pt-BR
VOLUME ["/data"]
EXPOSE 3333

CMD ["node", "dist/index.js"]
