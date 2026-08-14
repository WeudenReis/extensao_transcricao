import { Router } from 'express';
import type { PainelClient } from '../painel/client.js';
import { ehTipoReuniao, validarCnpj, normalizarCnpj } from '../painel/client.js';
import { assincrono } from './reunioes.js';
import { createLogger } from '../log.js';

/**
 * Consultas ao painel interno que a EXTENSÃO precisa fazer:
 *
 *   GET /api/painel/vendedores        → seletor de vendedor (apresentação agendada)
 *   GET /api/painel/onboarding?cnpj=  → dados do cliente na migração
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
      res.json({ encontrado: cliente !== null, cliente });
    })
  );

  return router;
}
