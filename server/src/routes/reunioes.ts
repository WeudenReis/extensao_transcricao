import { Router, type Request, type Response, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { RecallClient } from '../recall/client.js';
import type { ChatproClient } from '../chatpro/client.js';
import { ContasGoogle, ContaNaoConectada, ContaGoogleExpirada } from '../google/contas.js';
import { criarLinkDoMeet, MeetLinkError } from '../google/meetLink.js';
import { criarReuniao } from '../recall/criarReuniao.js';
import { resumirReuniao } from './meetings.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * O botão "Entrar na reunião" do chatPro.
 *
 *   POST /api/reunioes/iniciar   → gera o link, manda pro cliente, chama o bot
 *   GET  /api/google/status      → a extensão mostra "conectado como fulano@"
 *   GET  /oauth/google/conectar  → abre o consent do Google
 *   GET  /oauth/google/callback  → guarda a conta e fecha a aba
 *   POST /api/google/desconectar
 *
 * Um clique dispara quatro coisas, nesta ordem:
 *
 *   1. cria o link do Meet na agenda DO ATENDENTE (conta pessoal serve)
 *   2. manda o link pro cliente na conversa do chatPro
 *   3. põe o bot do Recall na sala
 *   4. devolve o link pra extensão abrir
 *
 * A ordem importa. O link vem primeiro porque sem ele nada acontece. A mensagem
 * vem antes do bot porque é o que o cliente espera ver; se o bot falhar, o
 * atendimento continua e a reunião fica marcada como 'failed' no painel. O
 * contrário — bot na sala e cliente sem link — seria pior.
 *
 * Com `quando` no corpo, os mesmos quatro passos acontecem pra uma data futura:
 * o evento nasce no horário combinado, o cliente recebe "reunião marcada para
 * …" e o bot fica agendado no Recall em vez de entrar agora.
 */

const log = createLogger('routes/reunioes');

/** Texto que vai pro cliente. `{link}` é trocado pela URL da reunião. */
export const MENSAGEM_PADRAO = 'Segue o link da nossa reunião: {link}';

/**
 * Texto da reunião MARCADA. `{quando}` vira "quinta, 21/08, às 14h" — sem isso
 * o cliente receberia "segue o link" e entraria numa sala vazia agora.
 */
export const MENSAGEM_AGENDADA_PADRAO = 'Reunião marcada para {quando}: {link}';

/** Fuso do atendimento. O cliente lê a hora dele, não UTC. */
export const FUSO = 'America/Sao_Paulo';

/** Teto do agendamento. Além disso é engano de digitação, não compromisso. */
export const MAX_DIAS_AGENDAMENTO = 90;

export const iniciarSchema = z.object({
  sessionId: z.string().uuid('sessionId deve ser o UUID da conversa do chatPro.'),
  /** Id da instalação da extensão — aponta pra conta Google conectada. */
  deviceId: z.string().min(8, 'deviceId ausente — reinstale a extensão.'),
  instanceId: z.string().nullish(),
  /** Nome do contato, só pra dar título ao evento na agenda. */
  contato: z.string().max(120).nullish(),
  /** Sobrescreve o texto enviado ao cliente. */
  mensagem: z.string().max(1000).nullish(),
  /**
   * Reunião marcada pra depois, em ISO 8601 COM fuso. Exigir o fuso é o que
   * impede "14:00" virar 14 h em UTC — o cliente receberia 11 h da manhã.
   */
  quando: z
    .string()
    .datetime({
      offset: true,
      message: 'quando deve ser uma data ISO 8601 com fuso (ex.: 2026-08-21T14:00:00-03:00).',
    })
    .nullish()
    .superRefine((valor, ctx) => {
      if (valor === null || valor === undefined) return;
      const alvo = Date.parse(valor);
      const agora = Date.now();
      if (alvo <= agora) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Esse horário já passou. Escolha uma data futura.',
        });
        return;
      }
      if (alvo - agora > MAX_DIAS_AGENDAMENTO * 24 * 60 * 60 * 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Dá pra marcar até ${MAX_DIAS_AGENDAMENTO} dias à frente.`,
        });
      }
    }),
});

const PARTES_DATA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO,
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  // h23 explícito: sem isso a meia-noite pode sair como "24h" em algum ICU.
  hourCycle: 'h23',
});

/** Data no calendário de São Paulo (YYYY-MM-DD), pra saber se é hoje/amanhã. */
function diaLocal(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Como a data aparece pro cliente: "hoje às 14h", "amanhã às 9h30",
 * "sexta, 21/08, às 14h". ISO 8601 numa mensagem de WhatsApp ninguém lê, e
 * "sexta" sozinho, daqui a três semanas, é qualquer sexta.
 */
export function formatarQuando(quando: Date, agora: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const parte of PARTES_DATA.formatToParts(quando)) {
    if (parte.type !== 'literal') p[parte.type] = parte.value;
  }
  const minuto = p.minute ?? '00';
  const hora = `${Number(p.hour ?? '0')}h${minuto === '00' ? '' : minuto}`;

  const distancia = Math.round(
    (Date.parse(`${diaLocal(quando)}T00:00:00Z`) - Date.parse(`${diaLocal(agora)}T00:00:00Z`)) /
      86_400_000
  );
  if (distancia === 0) return `hoje às ${hora}`;
  if (distancia === 1) return `amanhã às ${hora}`;

  // "quinta-feira" fica longo demais no meio da frase; "quinta" basta.
  const diaSemana = (p.weekday ?? '').replace('-feira', '');
  return `${diaSemana}, ${p.day ?? ''}/${p.month ?? ''}, às ${hora}`;
}

function assincrono(
  handler: (req: Request, res: Response) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

export interface ReunioesRouterDeps {
  db: Db;
  contas: ContasGoogle;
  chatpro: ChatproClient;
  recall: RecallClient | undefined;
  botName: string;
  /** Injetável nos testes — evita bater no Google de verdade. */
  criarLink?: typeof criarLinkDoMeet;
}

export function createReunioesRouter(deps: ReunioesRouterDeps): Router {
  const { db, contas, chatpro, recall, botName } = deps;
  const criarLink = deps.criarLink ?? criarLinkDoMeet;
  const router = Router();

  // ─── Conta Google do atendente ─────────────────────────────────────────────

  router.get('/api/google/status', (req, res) => {
    const deviceId = String(req.query.device ?? '');
    if (!deviceId) {
      res.status(400).json({ error: 'device é obrigatório.' });
      return;
    }
    res.json({ ...contas.status(deviceId), configurado: contas.estaConfigurado() });
  });

  router.get('/oauth/google/conectar', (req, res) => {
    const deviceId = String(req.query.device ?? '');
    if (!deviceId) {
      res.status(400).type('html').send(pagina('Faltou o identificador da extensão.', false));
      return;
    }
    if (!contas.estaConfigurado()) {
      res
        .status(503)
        .type('html')
        .send(
          pagina(
            'O servidor está sem GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. ' +
              'Configure no .env e reinicie.',
            false
          )
        );
      return;
    }
    res.redirect(contas.urlDeConsentimento(deviceId, randomUUID()));
  });

  router.get(
    '/oauth/google/callback',
    assincrono(async (req, res) => {
      const code = String(req.query.code ?? '');
      const state = String(req.query.state ?? '');
      if (!code || !state) {
        res.status(400).type('html').send(pagina('O Google não devolveu o código.', false));
        return;
      }
      try {
        const { email } = await contas.concluirConexao(code, state);
        res
          .type('html')
          .send(pagina(`Conta conectada: ${email ?? 'ok'}. Pode fechar esta aba.`, true));
      } catch (err) {
        log.error('falha ao conectar conta Google', err);
        res.status(400).type('html').send(pagina(errorMessage(err), false));
      }
    })
  );

  router.post('/api/google/desconectar', (req, res) => {
    const deviceId = String((req.body as { deviceId?: unknown })?.deviceId ?? '');
    if (!deviceId) {
      res.status(400).json({ error: 'deviceId é obrigatório.' });
      return;
    }
    contas.desconectar(deviceId);
    res.json({ ok: true });
  });

  // ─── O botão ───────────────────────────────────────────────────────────────

  router.post(
    '/api/reunioes/iniciar',
    assincrono(async (req, res) => {
      const parsed = iniciarSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Corpo inválido.',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      const { sessionId, deviceId } = parsed.data;
      const instanceId = parsed.data.instanceId ?? null;
      const contato = parsed.data.contato ?? null;
      const quando = parsed.data.quando ? new Date(parsed.data.quando) : null;

      // 1. Link do Meet, na agenda de quem clicou.
      let meet;
      try {
        const accessToken = await contas.accessToken(deviceId);
        meet = await criarLink({
          accessToken,
          titulo: contato ? `Atendimento chatPro — ${contato}` : 'Atendimento chatPro',
          // Marcada: o evento cai no horário combinado, não em cima do clique.
          ...(quando ? { inicio: quando } : {}),
        });
      } catch (err) {
        if (err instanceof ContaNaoConectada) {
          // Cobre os dois casos: nunca conectou, e conectou mas o token venceu
          // (ContaGoogleExpirada herda desta). A saída é a mesma; o texto muda.
          res.status(409).json({
            error:
              err instanceof ContaGoogleExpirada
                ? 'Conexão com o Google expirou.'
                : 'Conta Google não conectada.',
            detail: `${err.message} Abra a extensão e clique em "Conectar conta Google".`,
            precisaConectar: true,
          });
          return;
        }
        const status = err instanceof MeetLinkError ? err.status : 0;
        log.error('falha ao criar o link do Meet', err);
        res.status(502).json({
          error: 'Não foi possível criar o link da reunião.',
          detail: errorMessage(err),
          ...(status === 401 || status === 403
            ? { detalheExtra: 'Reconecte a conta Google pela extensão.', precisaConectar: true }
            : {}),
        });
        return;
      }

      // 2. Manda o link pro cliente. Se falhar, PARA: um bot entrando numa sala
      //    que o cliente nem sabe que existe não ajuda ninguém.
      const modelo =
        parsed.data.mensagem ?? (quando ? MENSAGEM_AGENDADA_PADRAO : MENSAGEM_PADRAO);
      const texto = modelo
        .replace('{quando}', quando ? formatarQuando(quando) : '')
        .replace('{link}', meet.meetUrl);
      const envio = await chatpro.enviarMensagem({ sessionId, message: texto, instanceId });
      if (!envio.ok) {
        res.status(502).json({
          error: 'O link foi criado, mas não deu pra enviar pro cliente.',
          detail: envio.motivo,
          meetUrl: meet.meetUrl,
          hint: 'Você pode colar o link na conversa manualmente.',
        });
        return;
      }

      // 3. Bot na sala. Falhar aqui não desfaz o atendimento — a reunião fica
      //    registrada como 'failed' no painel e dá pra reenviar de lá.
      const r = await criarReuniao(
        { db, recall, botName },
        {
          meetingUrl: meet.meetUrl,
          sessionId,
          chatproInstanceId: instanceId,
          origem: 'api',
          joinAt: quando,
        }
      );

      log.info(
        `reunião ${quando ? `marcada pra ${quando.toISOString()}` : 'iniciada'} pela sessão ` +
          `${sessionId}: ${meet.meetingCode ?? '?'}, bot ${r.ok ? 'ok' : 'FALHOU'}.`
      );

      res.status(201).json({
        meetUrl: meet.meetUrl,
        meetingCode: meet.meetingCode,
        mensagemEnviada: true,
        gravando: r.ok,
        // A extensão usa isto pra não abrir a sala de uma reunião que é depois.
        agendadaPara: quando ? quando.toISOString() : null,
        quandoTexto: quando ? formatarQuando(quando) : null,
        ...(r.ok
          ? { meeting: resumirReuniao(r.meeting) }
          : {
              avisoGravacao: quando
                ? `A reunião foi marcada, mas o bot não foi agendado: ${r.erro}`
                : `A reunião abriu, mas o bot não entrou: ${r.erro}`,
            }),
      });
    })
  );

  return router;
}

/** Página simples de retorno do OAuth, na identidade do chatPro. */
function pagina(mensagem: string, sucesso: boolean): string {
  const cor = sucesso ? '#25D066' : '#ff6b6b';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>chatPro — conta Google</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1d2125;color:#E6E5E8;
       font-family:'Space Grotesk',system-ui,sans-serif;padding:24px}
  .c{background:#2c333a;border-radius:14px;padding:32px;max-width:420px;text-align:center}
  h1{margin:0 0 12px;font-size:1.15rem;color:${cor}}
  p{margin:0;line-height:1.55;color:#D1D1D5;font-size:.95rem}
</style></head>
<body><div class="c">
  <h1>${sucesso ? 'Tudo certo' : 'Não deu certo'}</h1>
  <p>${escapar(mensagem)}</p>
</div></body></html>`;
}

function escapar(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
