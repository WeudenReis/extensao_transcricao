import { Router } from 'express';
import type { PainelClient } from '../painel/client.js';
import { validarCnpj, normalizarCnpj } from '../painel/client.js';
import { assincrono } from './reunioes.js';
import { createLogger } from '../log.js';

/**
 * Consultas ao painel interno que a EXTENSÃO precisa fazer:
 *
 *   GET /api/painel/vendedores        → seletor de vendedor (apresentação agendada)
 *   GET /api/painel/onboarding?cnpj=  → dados do cliente na migração
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
      const cliente = await painel.onboardingPorCnpj(cnpj);
      // Log sem o CNPJ inteiro: é dado de cliente, e o resultado já diz o que
      // importa pro diagnóstico.
      log.info(
        `onboarding consultado (…${normalizarCnpj(cnpj).slice(-4)}): ` +
          (cliente ? 'encontrado' : 'não encontrado/indisponível')
      );
      // 200 com `encontrado:false` em vez de 404: pra extensão, "não achou" e
      // "painel fora do ar" terminam igual — o atendente preenche na mão.
      res.json({ encontrado: cliente !== null, cliente });
    })
  );

  return router;
}
