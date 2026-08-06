# Hospedar o backend (sair do localhost)

## Por que NÃO dá pra usar Vercel/Netlify

O Vercel roda **funções serverless**: código sem estado que liga por poucos segundos
e desliga. Nosso backend precisa do contrário e por isso lá dá **404 / não funciona**:

- fica **sempre ligado** recebendo os pedaços de áudio da chamada;
- **grava arquivos em disco** e junta depois (o disco do Vercel é temporário);
- roda **filas e timers em segundo plano** (Voreo, reprocessamento, expurgo);
- transcreve com **Whisper** (modelo grande + minutos de CPU) — não cabe no limite serverless.

## Onde funciona

Qualquer lugar que rode um **container Docker sempre-ativo com disco persistente**:

| Plataforma | Custo | Observação |
|-----------|-------|-----------|
| **Railway** | ~US$5/mês (crédito inicial) | mais fácil; detecta o Dockerfile sozinho |
| **Render** | free spina-down / ~US$7 pra ficar sempre no ar | o free desliga por inatividade (ruim pra receber áudio) |
| **Fly.io** | franquia grátis pequena | bom se souber usar CLI |
| **VPS** (Contabo, Hetzner, Oracle Free) | de grátis a ~US$5 | mais controle, mais trabalho |

Já existe um `Dockerfile` na raiz do projeto pronto pra qualquer um deles.

## Passo a passo (Railway — mais simples)

1. Faça login em https://railway.app com o GitHub.
2. **New Project → Deploy from GitHub repo →** `WeudenReis/extensao_transcricao`.
3. O Railway detecta o `Dockerfile` e builda.
4. **Adicione um Volume** montado em `/data` (senão perde tudo a cada deploy).
5. Em **Variables**, defina conforme o tamanho da instância:
   - Instância **≥ 1 GB de RAM**: pode deixar o Whisper local (grátis). `STT_PROVIDER=local`.
   - Instância **pequena (512 MB)**: o Whisper local pode faltar memória — use Deepgram:
     `STT_PROVIDER=deepgram` e `STT_API_KEY=<sua-chave>` (rápido, mas pago por minuto).
   - Opcional: `VOREO_WEBHOOK_URL`, `VOREO_API_KEY`.
6. **Generate Domain** → você recebe uma URL tipo `https://seuapp.up.railway.app`.
7. Na **extensão**, abra o popup → **Configurar backend** → cole essa URL no lugar de
   `http://localhost:3333`. Pronto: os áudios vão pra nuvem, não mais pro seu PC.

O CORS do backend já libera as rotas `/api/*` pra extensão (`chrome-extension://…`),
então não precisa configurar mais nada.

## Grátis de verdade sem hospedar: rodar em cada máquina

Como a análise final acontece **na Voreo** (o destino central), você **não precisa** de um
servidor central. O modelo mais barato (US$ 0) é: cada atendente instala a extensão e roda
o backend local (dá dois cliques em `server/autostart/INSTALAR-inicializacao-automatica.vbs`
— ele inicia sozinho com o Windows, escondido). Cada máquina captura, transcreve de graça
com o Whisper local e manda pra Voreo. O "localhost" fica invisível pro atendente.

Use a hospedagem só se você quiser um **ponto central** que você controla (ex.: revisar todas
as transcrições num lugar só antes da Voreo).

## Importante: publicar as mudanças primeiro

O deploy usa o que está no GitHub (branch `main`). As últimas mudanças (Whisper local grátis,
inicialização automática) precisam ser enviadas antes:

```
cd C:\Users\weude\projetos\extensao_transcricao
git add -A
git commit -m "feat: transcricao local gratuita + inicializacao automatica + Dockerfile"
git push origin main
```
