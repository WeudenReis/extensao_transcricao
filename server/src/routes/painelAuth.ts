import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { createLogger } from '../log.js';

/**
 * Tranca do painel e das rotas de leitura.
 *
 * Por que existe: pro Recall.ai entregar os webhooks, o servidor precisa estar
 * acessível por HTTPS público (túnel ou hospedagem) — é o que o SETUP manda
 * fazer. Só que o túnel expõe o app INTEIRO, não só `/webhooks/recall`. Sem
 * isso aqui, quem descobrisse a URL leria `GET /api/meetings/:id` e baixaria a
 * transcrição das reuniões, com nome e e-mail dos participantes — dado sensível
 * de cliente (LGPD) — e ainda poderia criar bots na conta, que são cobrados por
 * hora.
 *
 * O que NÃO passa por aqui:
 * - `/webhooks/*` — quem chama é o Recall/Google, que se autentica por
 *   assinatura própria (Svix / OIDC). Exigir token quebraria a entrega.
 * - `/api/capture/*` — ingestão da extensão (só escrita, não devolve
 *   transcrição). Exigir token ali quebraria a extensão já distribuída.
 *
 * Sem PANEL_TOKEN configurado tudo continua aberto, com aviso alto no boot:
 * é o modo de desenvolvimento em localhost, que é onde o projeto começa.
 */

const log = createLogger('painelAuth');

/** Cookie pra sessão do navegador: entra uma vez com ?token= e continua valendo. */
export const COOKIE_TOKEN = 'painel_token';

/** Caminhos que nunca exigem token (têm autenticação própria, ou não vazam nada). */
const LIVRES = ['/webhooks/', '/api/capture/', '/api/health'];

export function ehCaminhoLivre(caminho: string): boolean {
  return LIVRES.some((prefixo) => caminho === prefixo || caminho.startsWith(prefixo));
}

/** Comparação em tempo constante — evita descobrir o token por cronometragem. */
export function tokenConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Lê o token do header, da query ou do cookie — nesta ordem. */
export function extrairToken(entrada: {
  authorization?: string | undefined;
  query?: unknown;
  cookie?: string | undefined;
}): string | undefined {
  const auth = entrada.authorization ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const valor = auth.slice(7).trim();
    if (valor) return valor;
  }
  if (typeof entrada.query === 'string' && entrada.query !== '') return entrada.query;

  for (const parte of (entrada.cookie ?? '').split(';')) {
    const [nome, ...resto] = parte.trim().split('=');
    if (nome === COOKIE_TOKEN && resto.length > 0) {
      const valor = decodeURIComponent(resto.join('='));
      if (valor) return valor;
    }
  }
  return undefined;
}

const PAGINA_NEGADA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acesso restrito</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d2125;color:#E6E5E8;
       font-family:'Space Grotesk',system-ui,sans-serif;padding:24px}
  .cartao{background:#2c333a;border-radius:14px;padding:32px;max-width:440px;text-align:center}
  h1{margin:0 0 12px;font-size:1.25rem;color:#25D066}
  p{margin:0 0 8px;line-height:1.55;color:#D1D1D5;font-size:.95rem}
  code{background:#1d2125;padding:2px 6px;border-radius:4px;font-size:.85rem}
</style></head>
<body><div class="cartao">
  <h1>Acesso restrito</h1>
  <p>Este painel mostra transcrição de reunião, então pede uma chave.</p>
  <p>Abra com <code>?token=SEU_TOKEN</code> no fim do endereço — o valor é o
     <code>PANEL_TOKEN</code> do arquivo <code>.env</code>.</p>
</div></body></html>`;

/**
 * Middleware. Com `token` vazio, não tranca nada (dev em localhost) — o aviso
 * de boot é quem cobra a configuração.
 */
export function criarPainelAuth(token: string | undefined): RequestHandler {
  if (!token) {
    return (_req, _res, next) => {
      next();
    };
  }
  log.info('painel protegido por PANEL_TOKEN.');

  return (req, res, next) => {
    if (ehCaminhoLivre(req.path)) {
      next();
      return;
    }
    const recebido = extrairToken({
      authorization: req.headers.authorization,
      query: req.query.token,
      cookie: req.headers.cookie,
    });
    if (recebido && tokenConfere(recebido, token)) {
      // Veio pela URL: guarda no cookie pra navegação seguinte não precisar
      // repetir o token (e pra ele sumir da barra de endereço).
      if (typeof req.query.token === 'string' && req.query.token !== '') {
        res.setHeader(
          'Set-Cookie',
          `${COOKIE_TOKEN}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
        );
      }
      next();
      return;
    }

    log.warn(`acesso sem token válido recusado: ${req.method} ${req.path}`);
    if (req.accepts(['html', 'json']) === 'html') {
      res.status(401).type('html').send(PAGINA_NEGADA);
      return;
    }
    res.status(401).json({
      error: 'Acesso restrito.',
      detail: 'Mande o PANEL_TOKEN em Authorization: Bearer, ou abra a página com ?token=...',
    });
  };
}
