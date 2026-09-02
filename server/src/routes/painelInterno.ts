import { Router } from 'express';
import type { Db } from '../db.js';
import type { ChatproClient } from '../chatpro/client.js';
import type { PainelClient } from '../painel/client.js';
import { ehTipoReuniao, validarCnpj, normalizarCnpj } from '../painel/client.js';
import { assincrono } from './reunioes.js';
import { createLogger } from '../log.js';

/**
 * Consultas ao painel interno que a EXTENSÃO precisa fazer:
 *
 *   GET /api/painel/vendedores        → seletor de vendedor (apresentação agendada)
 *   GET /api/painel/onboarding?cnpj=  → dados do cliente na migração
 *   GET /api/painel/cnpj?cnpj=        → razão social pro formulário se preencher
 *   GET /api/painel/diagnostico       → por que o painel não está respondendo
 *
 * São só repasses pro PainelClient — o contrato da plataforma interna mora lá,
 * num lugar só. Aqui fica o que é responsabilidade de borda: validar o CNPJ
 * ANTES de consultar (dígitos verificadores — um CNPJ errado devolveria a
 * empresa errada) e nunca deixar a indisponibilidade do painel virar erro 5xx
 * pro atendente.
 *
 * As rotas ficam atrás da tranca do painel: /api/* já passa pelo painelAuth no
 * index.ts, então nada de auth aqui dentro.
 */

const log = createLogger('routes/painelInterno');

export interface PainelInternoRouterDeps {
  painel: PainelClient;
  /** Pra listar as últimas reuniões — o painel não expõe listagem. */
  db: Db;
  /** Pra ler o contato (lead) da conversa e pré-preencher o formulário. */
  chatpro: ChatproClient;
}

export function createPainelInternoRouter(deps: PainelInternoRouterDeps): Router {
  const { painel } = deps;
  const router = Router();

  // A aba chama isto ao abrir: é a resposta do painel que diz o que este
  // atendente pode marcar e como cada tipo é atribuído. Desenhar o formulário
  // daqui evita oferecer tudo a todo mundo e levar 403 com os campos cheios.
  router.get(
    '/api/painel/me',
    assincrono(async (req, res) => {
      const email = String(req.query.email ?? '').trim();
      if (!email || !email.includes('@')) {
        res.status(400).json({ error: 'Informe ?email= do atendente.' });
        return;
      }
      const eu = await painel.me(email);
      if (!eu) {
        // 200 com identificado:false: pra extensão, "painel fora do ar" e
        // "e-mail não é usuário ativo" terminam no mesmo lugar — não dá pra
        // marcar, e a tela precisa dizer isso sem quebrar.
        res.json({ configurado: painel.estaConfigurado(), identificado: false });
        return;
      }
      log.info(`painel reconheceu ${eu.email} (${eu.papel ?? 'papel?'}).`);
      res.json({ configurado: true, identificado: true, eu });
    })
  );

  // Grade de horários de um dia, já filtrada pelo tipo.
  router.get(
    '/api/painel/horarios',
    assincrono(async (req, res) => {
      const tipo = String(req.query.tipo ?? '');
      const data = String(req.query.data ?? '');
      const email = String(req.query.email ?? '').trim();
      const clientType = req.query.clientType === 'base' ? 'base' : req.query.clientType === 'prospect' ? 'prospect' : undefined;
      if (!ehTipoReuniao(tipo) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(data) || !email) {
        res.status(400).json({ error: 'Informe ?tipo=, ?data=YYYY-MM-DD e ?email=.' });
        return;
      }
      const grade = await painel.horarios({ tipo, data, actorEmail: email, clientType });
      // Grade nula (painel fora) vira lista vazia com aviso: a tela mostra
      // "sem horário" em vez de estourar.
      res.json({ disponivel: grade !== null, grade: grade ?? { disponiveis: [], bloqueados: [], maxDate: null } });
    })
  );

  // Rota de CONSERTO, não de produto: sem ela, "PAINEL_API_URL aponta pro site
  // em vez da API", "token trocado" e "painel fora do ar" chegam na tela com o
  // mesmo sintoma — tudo vazio, sem explicação. Aqui a pessoa que instalou o
  // servidor lê a diferença em uma frase.
  router.get(
    '/api/painel/diagnostico',
    assincrono(async (req, res) => {
      const email = String(req.query.email ?? '').trim();
      const resultado = await painel.diagnosticar(email || undefined);
      if (resultado.problema) {
        log.warn(`diagnóstico do painel: ${resultado.problema} — ${resultado.detalhe ?? ''}`);
      }
      // 200 mesmo com problema: o corpo É o diagnóstico, e um 5xx faria a
      // ferramenta de diagnóstico parecer o defeito. O corpo leva só a
      // classificação e a frase — nunca token nem credencial.
      res.json({ configurado: painel.estaConfigurado(), ...resultado });
    })
  );

  /**
   * Gera o checklist de onboarding da migração.
   *
   * É a única rota de ESCRITA daqui, e existe porque o painel recusa marcar
   * migração sem checklist — mas o link do onboarding é gerado DURANTE a
   * migração no fluxo do time, não antes. Sem isto, o atendente teria que sair
   * da tela no meio do atendimento.
   *
   * Nunca é chamada sozinha: só pelo botão que a aba mostra quando o painel
   * disse que falta checklist.
   */
  router.post(
    '/api/painel/migracao/link',
    assincrono(async (req, res) => {
      const corpo = (req.body ?? {}) as Record<string, unknown>;
      const cnpj = String(corpo.cnpj ?? '');
      const vendedorEmail = String(corpo.vendedorEmail ?? '').trim();
      const instanceCode = String(corpo.instanceCode ?? '').trim();

      if (!validarCnpj(cnpj)) {
        res.status(400).json({ error: 'CNPJ inválido.' });
        return;
      }
      if (!vendedorEmail.includes('@') || instanceCode === '') {
        res.status(400).json({
          error: 'Informe o vendedor da conta e o código da instância.',
        });
        return;
      }

      const r = await painel.gerarLinkDeMigracao({ cnpj, vendedorEmail, instanceCode });
      if (!r.ok) {
        log.warn(`não deu pra gerar o checklist (…${normalizarCnpj(cnpj).slice(-4)}): ${r.motivo}`);
        res.status(502).json({ error: 'Não deu pra gerar o link do onboarding.', detail: r.motivo });
        return;
      }
      res.json({ ok: true, publicUrl: r.publicUrl, razaoSocial: r.razaoSocial });
    })
  );

  // As últimas reuniões de quem está com a aba aberta. Vem do NOSSO banco:
  // o painel não expõe listagem, e a linha local existe mesmo quando quem
  // grava é ele.
  router.get(
    '/api/painel/minhas-reunioes',
    assincrono(async (req, res) => {
      const email = String(req.query.email ?? '').trim();
      if (!email || !email.includes('@')) {
        res.status(400).json({ error: 'Informe ?email= do atendente.' });
        return;
      }
      const limite = Math.min(Math.max(Number(req.query.limite) || 5, 1), 20);
      const linhas = deps.db.reunioesDoAtendente(email, limite);
      res.json({
        reunioes: linhas.map((r) => {
          // O nome do cliente mora no JSON dos dados cadastrais; JSON quebrado
          // não pode derrubar a listagem inteira.
          let cliente: string | null = null;
          let empresa: string | null = null;
          try {
            const c = r.cliente_json ? JSON.parse(r.cliente_json) : null;
            if (c && typeof c === 'object') {
              cliente = typeof c.nome === 'string' ? c.nome : null;
              empresa = typeof c.empresa === 'string' ? c.empresa : null;
            }
          } catch {
            // segue sem o nome
          }
          return {
            id: r.id,
            tipo: r.tipo,
            cliente,
            empresa,
            meetUrl: r.meeting_url,
            // O horário DA REUNIÃO quando há um: é ele que lembra o atendente
            // da reunião de segunda, não a data em que clicou pra marcar.
            quando: r.agendada_para ?? r.started_at ?? r.created_at,
            agendada: Boolean(r.agendada_para),
            // A reunião chegou ao painel? É o que separa "marcada" de
            // "aconteceu por aqui e precisa ser lançada lá".
            noPainel: Boolean(r.painel_meeting_id),
            sessionId: r.session_id,
          };
        }),
      });
    })
  );

  // Nome e telefone do contato da conversa — o formulário nasce preenchido
  // e EDITÁVEL: é palpite bom, não verdade; quem confirma é o atendente.
  router.get(
    '/api/painel/contato',
    assincrono(async (req, res) => {
      const sessionId = String(req.query.sessionId ?? '').trim();
      if (!sessionId) {
        res.status(400).json({ error: 'Informe ?sessionId=.' });
        return;
      }
      res.json(await deps.chatpro.contatoDaSessao(sessionId));
    })
  );

  // A BUSCA do histórico: nome, razão social, CNPJ ou código de instância.
  // Procura no NOSSO banco (o painel não expõe listagem), em TODAS as
  // reuniões, não só as de quem pergunta — o caso real é "o cliente ligou e
  // ninguém lembra quem marcou".
  router.get(
    '/api/painel/buscar',
    assincrono(async (req, res) => {
      const q = String(req.query.q ?? '').trim();
      if (q.length < 2) {
        res.status(400).json({ error: 'Digite ao menos 2 caracteres.' });
        return;
      }
      const linhas = deps.db.buscarReunioes(q, 30);
      res.json({
        reunioes: linhas.map((r) => {
          let cliente: string | null = null;
          let empresa: string | null = null;
          let cnpj: string | null = null;
          let instancia: string | null = null;
          try {
            const c = r.cliente_json ? JSON.parse(r.cliente_json) : null;
            if (c && typeof c === 'object') {
              cliente = typeof c.nome === 'string' ? c.nome : null;
              empresa = typeof c.empresa === 'string' ? c.empresa : null;
              cnpj = typeof c.cnpj === 'string' ? c.cnpj : null;
              instancia = typeof c.instancia === 'string' ? c.instancia : null;
            }
          } catch {
            // JSON quebrado: a linha aparece sem os dados cadastrais
          }
          return {
            id: r.id,
            tipo: r.tipo,
            cliente,
            empresa,
            cnpj,
            instancia,
            meetUrl: r.meeting_url,
            quando: r.agendada_para ?? r.started_at ?? r.created_at,
            agendada: Boolean(r.agendada_para),
            noPainel: Boolean(r.painel_meeting_id),
            sessionId: r.session_id,
            atendente: r.atendente_email,
          };
        }),
      });
    })
  );

  router.get(
    '/api/painel/vendedores',
    assincrono(async (_req, res) => {
      // `[]` cobre tanto "sem PAINEL_API_URL" quanto "painel fora do ar" — a
      // extensão mostra o seletor vazio e o campo de e-mail livre.
      const vendedores = await painel.vendedores();
      res.json({ configurado: painel.estaConfigurado(), vendedores });
    })
  );

  router.get(
    '/api/painel/onboarding',
    assincrono(async (req, res) => {
      const cnpj = String(req.query.cnpj ?? '');
      if (!validarCnpj(cnpj)) {
        res.status(400).json({
          error: 'CNPJ inválido.',
          detail: 'Informe os 14 dígitos com dígitos verificadores corretos (?cnpj=).',
        });
        return;
      }
      const cliente = await painel.statusMigracao(cnpj);
      // Log sem o CNPJ inteiro: é dado de cliente, e o resultado já diz o que
      // importa pro diagnóstico.
      log.info(
        `checklist de migração consultado (…${normalizarCnpj(cnpj).slice(-4)}): ` +
          (cliente ? 'encontrado' : 'não encontrado/indisponível')
      );
      // 200 com `encontrado:false` em vez de 404: pra extensão, "não achou" e
      // "painel fora do ar" terminam igual — o atendente preenche na mão.
      //
      // `temChecklist` é o que a ABA precisa saber antes de deixar alguém
      // preencher um formulário de migração inteiro: sem checklist ativo o POST
      // recusa com 422. Mesma leitura de `dadosDoCnpj`: `false` também cobre
      // "não deu pra confirmar", porque prometer uma migração que o painel vai
      // recusar é pior que um aviso a mais na tela.
      res.json({
        encontrado: cliente !== null,
        cliente,
        temChecklist: cliente !== null && cliente.found !== false,
      });
    })
  );

  // Digitou o CNPJ, veio a razão social. Duas fontes atrás disto (o cadastro do
  // painel e a BrasilAPI), mas a tela não precisa saber de nenhuma delas — só
  // recebe o nome pronto e `fonte` pra dizer de onde veio.
  router.get(
    '/api/painel/cnpj',
    assincrono(async (req, res) => {
      const cnpj = String(req.query.cnpj ?? '');
      const dados = await painel.dadosDoCnpj(cnpj);
      // 200 SEMPRE, nunca 404: pra tela, "CNPJ ainda incompleto", "não achei" e
      // "fonte fora do ar" terminam no mesmo lugar — a pessoa digita o nome na
      // mão. Um 404 aqui viraria erro vermelho no meio de quem está digitando.
      //
      // `cnpjValido` separa o único caso que a tela trata diferente: enquanto o
      // CNPJ não fecha os dígitos verificadores, não há o que avisar — ninguém
      // foi consultado ainda.
      res.json({ encontrado: dados !== null, dados, cnpjValido: validarCnpj(cnpj) });
      log.debug(
        `consulta de CNPJ (…${normalizarCnpj(cnpj).slice(-4)}): ` +
          (dados ? `${dados.fonte}, checklist ${dados.temChecklist ? 'ativo' : 'ausente'}` : 'sem resposta')
      );
    })
  );

  return router;
}
