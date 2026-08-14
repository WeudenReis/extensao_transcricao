/**
 * Preload do teste do validador de painel.
 *
 * O script `scripts/testar-painel.mjs` é uma CLI: não dá pra injetar `fetchImpl`
 * nele como nos clientes do servidor. Então o `fetch` global é trocado ANTES do
 * script carregar (via `node --import`), e a suíte continua sem abrir socket
 * nenhum — nem pra loopback.
 *
 * O roteiro das respostas vem em RESPOSTAS_PAINEL (JSON): caminho → resposta.
 */

const roteiro = JSON.parse(process.env.RESPOSTAS_PAINEL ?? '{}');

/** Casa pelo começo do caminho: a URL real leva query (actor_email, date…). */
function respostaPara(caminho) {
  for (const [prefixo, resposta] of Object.entries(roteiro)) {
    if (caminho.startsWith(prefixo)) return resposta;
  }
  return null;
}

globalThis.fetch = async (endereco) => {
  const { pathname } = new URL(String(endereco));
  const combinada = respostaPara(pathname);

  if (combinada?.recusar) {
    const erro = new TypeError('fetch failed');
    erro.cause = { code: 'ECONNREFUSED' };
    throw erro;
  }

  // TLS quebrado: é o momento em que o script decide se sugere http:// — e a
  // sugestão errada mandaria os dois tokens em claro pela rede.
  if (combinada?.certificado) {
    const erro = new TypeError('fetch failed');
    erro.cause = { code: 'ERR_TLS_CERT_ALTNAME_INVALID' };
    throw erro;
  }

  const html = '<!doctype html><html><body><div id="root"></div></body></html>';
  const ehHtml = combinada?.html === true;
  const corpo = ehHtml ? html : JSON.stringify(combinada?.json ?? { error: 'rota nao existe' });

  return new Response(corpo, {
    status: combinada?.status ?? 404,
    headers: { 'content-type': ehHtml ? 'text/html; charset=utf-8' : 'application/json' },
  });
};
