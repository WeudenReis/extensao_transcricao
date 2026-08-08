# Como rodar o servidor (e como sair do localhost)

## O que este servidor exige

Antes de escolher onde hospedar, três restrições que eliminam metade das opções:

| exigência | por quê |
|---|---|
| **Processo sempre ativo** | os webhooks do Recall chegam quando a reunião acaba, não quando alguém acessa o site |
| **Resposta em até 15 s** | o Recall desiste depois disso; serviço que "dorme" e demora 50 s pra acordar falha na primeira entrega |
| **Disco que persiste** | o banco é SQLite. Sem volume, cada deploy apaga as reuniões |

Por isso **Vercel e Netlify não servem** — são serverless, sem processo contínuo
nem disco.

---

## Opção 1 — Rodar na sua máquina (é o que está funcionando hoje)

Dois cliques, uma vez só:

```
server\autostart\INSTALAR-inicializacao-automatica.vbs
```

Isso faz o servidor: subir junto com o Windows, rodar **escondido** (sem janela
preta), recompilar a cada reinício e voltar sozinho se cair.

Pra desligar: `DESINSTALAR-inicializacao.vbs` na mesma pasta.

**Serve pro dia a dia?** Serve, com uma ressalva: enquanto a máquina estiver
desligada, os webhooks não chegam. O Recall **retenta por 24 h**, então uma
reunião que acaba às 18h com o PC desligando às 19h ainda é entregue quando você
ligar de manhã. O que não funciona é ficar dias sem ligar.

---

## Opção 2 — Túnel: URL pública apontando pra sua máquina

Isto **não é hospedagem**, é um endereço público pro servidor que já roda aí. É
o caminho mais rápido pra sair do localhost sem migrar nada — o banco continua
no seu disco.

### Rápido (URL muda a cada reinício)

```
cloudflared tunnel --url http://localhost:3333
```

Serve pra testar hoje. Ruim pra valer, porque toda vez que reiniciar você precisa
recadastrar a URL no painel do Recall.

### Fixo (URL permanente, de graça)

Precisa de uma conta Cloudflare e um domínio nela.

```
cloudflared tunnel login
cloudflared tunnel create chatpro-reunioes
cloudflared tunnel route dns chatpro-reunioes reunioes.SEUDOMINIO.com.br
cloudflared tunnel run --url http://localhost:3333 chatpro-reunioes
```

Depois `cloudflared service install` pra subir junto com o Windows.

Aí `PUBLIC_BASE_URL=https://reunioes.SEUDOMINIO.com.br` e o webhook do Recall
aponta pra um endereço que nunca muda.

⚠️ **Antes de abrir qualquer túnel**, confirme que `PANEL_TOKEN` está preenchido.
O túnel publica o servidor inteiro, e as transcrições estão nele.

---

## Opção 3 — Hospedar de verdade

O cenário mudou em 2026 e vale saber antes de perder tempo:

| plataforma | situação em 2026 |
|---|---|
| **Fly.io** | acabou o tier grátis pra contas novas — é pay-as-you-go |
| **Koyeb** | tirou o compute grátis; web service exige o plano Pro |
| **Render** | tem web service grátis (512 MB), mas **dorme** com inatividade e **não tem disco persistente** no plano grátis |
| **Railway** | crédito de teste, depois pago |
| **Oracle Cloud** | **Always Free** continua: VM ARM com disco. É a única "grátis pra sempre" que atende as três exigências |

### Recomendado: Oracle Cloud Always Free

Uma VM ARM (Ampere A1) de verdade, ligada o tempo todo, com disco.

Pontos de atenção honestos:
- **Pede cartão de crédito** pra verificar identidade. Não cobra enquanto você
  ficar dentro do Always Free.
- A partir de junho/2026 o limite caiu para **2 OCPU e 12 GB** — continua de
  sobra pra este servidor.
- Pode faltar capacidade de ARM na região; às vezes é preciso tentar em outra.

Com a VM criada:

```bash
# na VM
sudo apt update && sudo apt install -y docker.io git
git clone https://github.com/WeudenReis/extensao_transcricao.git
cd extensao_transcricao && git checkout recall-ai

docker build -t chatpro-reunioes .
docker volume create dados-chatpro

docker run -d --name reunioes --restart always \
  -p 80:3333 \
  -v dados-chatpro:/dados \
  --env-file server/.env \
  chatpro-reunioes
```

Depois é só apontar um domínio (ou usar o IP) e pôr em `PUBLIC_BASE_URL`.

> Pra HTTPS, o mais simples é pôr um Cloudflare Tunnel na frente — evita
> configurar certificado na mão.

### Se preferir Render (grátis, com ressalvas)

Funciona, mas exige duas mudanças:

1. **Trocar SQLite por Postgres** (o Render dá um grátis) — é reescrever
   `server/src/db.ts`. Trabalho real.
2. Conviver com o **cold start**: a primeira entrega depois de um período ocioso
   provavelmente estoura os 15 s e falha. O Recall retenta, então a transcrição
   chega — só atrasada.

Não recomendo enquanto o time for pequeno: o esforço não compensa perto do
túnel ou da VM da Oracle.

---

## O que muda na extensão

Seja qual for o caminho, cada pessoa põe o endereço no popup da extensão:

```
Servidor → Endereço → https://reunioes.SEUDOMINIO.com.br
```

E o `.env` do servidor passa a ter:

```
PUBLIC_BASE_URL=https://reunioes.SEUDOMINIO.com.br
GOOGLE_REDIRECT_URI_EXTENSAO=https://reunioes.SEUDOMINIO.com.br/oauth/google/callback
```

⚠️ O `GOOGLE_REDIRECT_URI_EXTENSAO` novo precisa ser cadastrado como **Authorized
redirect URI** no OAuth Client do Google — senão a conexão de conta quebra com
`redirect_uri_mismatch`.

E no painel do Recall, o endpoint vira
`https://reunioes.SEUDOMINIO.com.br/webhooks/recall`.

---

## Resumindo

- **Testar hoje:** já funciona na sua máquina (autostart) + túnel rápido
- **Uso do time:** túnel nomeado com domínio fixo — 15 min, sem migrar nada
- **Independente da sua máquina:** VM Always Free da Oracle + Docker

Fontes: [Oracle Free Tier](https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm) ·
[Comparativo de tiers grátis 2026](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
