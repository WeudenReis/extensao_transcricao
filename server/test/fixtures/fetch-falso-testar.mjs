/**
 * Preload do teste de `scripts/testar.mjs`.
 *
 * O script é uma CLI: não dá pra injetar `fetchImpl` como nos clientes do
 * servidor. Então o `fetch` global é trocado ANTES da carga (via `node
 * --import`) e a suíte não abre socket nenhum — nem pra loopback.
 *
 * Este preload faz uma coisa a mais que o do painel: DENUNCIA cada chamada no
 * stdout, no formato `CHAMADA <método> <url> CORPO <json>`. É assim que o teste
 * prova o que interessa aqui — que sem flag de ação o script NÃO chamou
 * /messages/addComments e NÃO criou bot no Recall. Ausência de efeito não se
 * mede por texto bonito na tela; se mede pela chamada que não aconteceu.
 *
 * O roteiro das respostas vem em RESPOSTAS_TESTAR (JSON): pedaço da URL →
 * resposta.
 */

const roteiro = JSON.parse(process.env.RESPOSTAS_TESTAR ?? '{}');

/** Casa por pedaço da URL: o caminho do sparks muda de base conforme o .env. */
function respostaPara(url) {
  for (const [pedaco, resposta] of Object.entries(roteiro)) {
    if (url.includes(pedaco)) return resposta;
  }
  return null;
}

globalThis.fetch = async (endereco, opcoes = {}) => {
  const url = String(endereco);
  const corpoEnviado = typeof opcoes.body === 'string' ? opcoes.body : '';
  console.log(`CHAMADA ${opcoes.method ?? 'GET'} ${url} CORPO ${corpoEnviado}`);

  const combinada = respostaPara(url);
  return new Response(JSON.stringify(combinada?.json ?? {}), {
    status: combinada?.status ?? 404,
    headers: { 'content-type': 'application/json' },
  });
};
