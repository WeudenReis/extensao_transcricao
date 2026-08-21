import { Router, type Request, type Response, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, MeetingRow } from '../db.js';
import type { RecallClient } from '../recall/client.js';
import type { ChatproClient } from '../chatpro/client.js';
import {
  validarCnpj,
  ehTipoReuniao,
  PainelClient,
  PainelError,
  type DadosNovaReuniao,
} from '../painel/client.js';
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

/**
 * O que o CLIENTE recebe no WhatsApp.
 *
 * É um resumo da reunião, não só o link solto: quem recebe "segue o link" no
 * meio de uma conversa de atendimento não sabe de que reunião se trata, com
 * quem é, nem quando. Com dia, hora e responsável na mensagem, ela se explica
 * sozinha meses depois, quando alguém rolar a conversa pra cima.
 *
 * Formatação de WhatsApp: `*negrito*` (um asterisco de cada lado), sem
 * markdown de tabela e sem link entre colchetes — o WhatsApp mostra tudo isso
 * cru. Os placeholders são {quando}, {link}, {tipo} e {responsavel}.
 */
export const MENSAGEM_PADRAO =
  '*Reunião iniciada*{tipo}\n\n' +
  'Entre por aqui:\n{link}';

/**
 * Texto da reunião MARCADA.
 *
 * O `{quando}` fica CRU até o envio: a mensagem é montada quando o atendente
 * marca e entregue ~5 min antes do horário. Congelar "amanhã às 10h" aqui
 * faria o cliente ler isso no PRÓPRIO dia da reunião e entender o seguinte.
 */
export const MENSAGEM_AGENDADA_PADRAO =
  '*Reunião marcada*{tipo}\n\n' +
  '📅 {quando}{responsavel}\n\n' +
  'O link para entrar:\n{link}\n\n' +
  'Até lá!';

/**
 * Como cada tipo aparece PRA O CLIENTE. Os valores da API (`cs`,
 * `apresentacao`) são nomes internos — mandá-los crus no WhatsApp obrigaria o
 * cliente a adivinhar.
 */
const ROTULO_DO_TIPO: Record<string, string> = {
  apresentacao: 'de apresentação',
  migracao: 'de migração',
  implantacao: 'de implantação',
  cs: 'de acompanhamento',
};

/** Fuso do atendimento. O cliente lê a hora dele, não UTC. */
export const FUSO = 'America/Sao_Paulo';

/** Teto do agendamento. Além disso é engano de digitação, não compromisso. */
export const MAX_DIAS_AGENDAMENTO = 90;

/**
 * Reunião AGENDADA: o convite sai esta antecedência ANTES do horário, não na
 * hora de marcar — link mandado três dias antes se perde na conversa.
 */
export const ANTECEDENCIA_CONVITE_MS = 5 * 60_000;

export const TIPOS_REUNIAO = ['apresentacao', 'migracao', 'implantacao', 'cs'] as const;
export type TipoReuniao = (typeof TIPOS_REUNIAO)[number];

/**
 * Dados do cliente que implantação/CS/migração exigem. O CNPJ passa pelos
 * dígitos verificadores: ele vira chave de consulta no painel interno, e um
 * dígito trocado apontaria pra empresa errada.
 */
export const clienteSchema = z.object({
  nome: z.string().min(1, 'nome do cliente é obrigatório.').max(200),
  cnpj: z.string().refine(validarCnpj, 'CNPJ inválido — confira os 14 dígitos.'),
  /** Código da instância, formato chatpro-xxx. */
  instancia: z.string().min(1, 'instância do cliente é obrigatória.').max(80),
  telefone: z.string().min(8, 'telefone do cliente é obrigatório.').max(30),
  /** Razão social. O painel pede separado do nome de quem atende. */
  empresa: z.string().max(200).optional(),
  /**
   * `base` (já é cliente) ou `prospect`. Só a migração muda de verdade com
   * isso — base e prospect caem em pools diferentes de condutores, e mandar o
   * errado devolve a grade da outra fila.
   */
  clientType: z.enum(['base', 'prospect']).optional(),
  /** Implantação e CS não sobem sem isto — o painel devolve 422. */
  provedor: z.enum(['starter', 'cloud_api', 'api_disparos']).optional(),
  /**
   * E-mail do cliente. É por ele que o painel manda o convite com `.ics` — sem
   * ele o cliente só fica sabendo pelo WhatsApp.
   */
  email: z.string().email('E-mail do cliente inválido.').optional(),
  /** `true` quando o atendente marcou "não enviar e-mail" (vira skip_email). */
  semEmail: z.boolean().optional(),
  /**
   * Plano Oficial contratado — só a migração usa, e é opcional. Os valores
   * saíram do próprio 422 da API, não de suposição.
   */
  oficialPlan: z.enum(['oficial_1', 'oficial_2', 'oficial_3', 'base_sem_creditos']).optional(),
  /**
   * `cs_reason` — só o CS usa, e ele EXIGE. Não tem padrão razoável:
   * "treinamento de IA" e "retenção" são atendimentos diferentes, e escolher
   * por conta própria classificaria a reunião errado no relatório do painel.
   */
  csReason: z
    .enum(['treinamento_ia', 'treinamento_chat', 'treinamento_oficial', 'retencao', 'duvidas'])
    .optional(),
});

export type DadosCliente = z.infer<typeof clienteSchema>;

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
  // ─── Fluxo do time comercial (tudo opcional pra não quebrar a extensão antiga) ───
  /** apresentacao | migracao | implantacao | cs. */
  tipo: z.enum(TIPOS_REUNIAO).nullish(),
  /** Quem clicou — e-mail lido do @chatpro:auth da página do chatPro. */
  atendenteEmail: z.string().email('atendenteEmail deve ser um e-mail válido.').nullish(),
  /**
   * Id do atendente DENTRO do chatPro, lido do JWT guardado no
   * `@chatpro:auth`. É o que o `addComments` exige pra o comentário da reunião
   * sair no nome de quem conduziu, em vez do usuário único do `.env`.
   */
  atendenteUserId: z.string().max(120).nullish(),
  /**
   * `vendedor_email` — o vendedor DONO da conta. A migração exige; os outros
   * tipos aceitam. Não confundir com quem vai conduzir a reunião.
   */
  vendedorEmail: z.string().email('vendedorEmail deve ser um e-mail válido.').nullish(),
  /**
   * `assignee_email` — quem vai CONDUZIR. A aba só manda quando o `/me` disse
   * que a pessoa pode escolher (`can_choose_assignee`); mandar sem isso volta
   * 403 do painel ("Só supervisor pode escolher o responsável"). Quem manda a
   * regra é o painel, então aqui a gente só repassa.
   */
  assigneeEmail: z.string().email('assigneeEmail deve ser um e-mail válido.').nullish(),
  cliente: clienteSchema.nullish(),
}).superRefine((corpo, ctx) => {
  // Implantação, CS e migração são reuniões SOBRE uma conta que já existe (ou
  // vai existir) — sem nome/CNPJ/instância/telefone o painel não sabe de quem
  // é a reunião, e a atribuição comercial fica cega.
  if (corpo.tipo && corpo.tipo !== 'apresentacao' && !corpo.cliente) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cliente'],
      message:
        `Reunião de ${corpo.tipo} exige os dados do cliente ` +
        '(nome, CNPJ, instância e telefone).',
    });
  }
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

/**
 * Embrulho pra handler async: o Express 4 NÃO encaminha rejeição de promise
 * pro error handler — sem isto, um `throw` derrubaria o processo.
 * Exportado porque as outras rotas (painelInterno) usam o mesmo embrulho.
 */
export function assincrono(
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
  /**
   * Painel interno comercial — distribuição de responsável e registro.
   * Opcional: sem ele, entra um client desconfigurado (todos os fallbacks) —
   * é o que mantém o index.ts compilando até o wiring real chegar.
   */
  painel?: PainelClient;
  botName: string;
  /**
   * `true` = a GRAVAÇÃO É DO PAINEL. Este servidor não cria bot nenhum.
   *
   * Os dois lados ligados poriam DOIS bots na mesma sala — dois robôs entrando
   * na frente do cliente, e a hora do Recall cobrada em dobro.
   */
  gravacaoPeloPainel?: boolean;
  /** Injetável nos testes — evita bater no Google de verdade. */
  criarLink?: typeof criarLinkDoMeet;
}

export function createReunioesRouter(deps: ReunioesRouterDeps): Router {
  const { db, contas, chatpro, recall, botName } = deps;
  const gravacaoPeloPainel = deps.gravacaoPeloPainel === true;
  const painel =
    deps.painel ??
    new PainelClient({ baseUrl: undefined, extAgendaToken: undefined });
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
      const tipo = parsed.data.tipo ?? null;
      const atendenteEmail = parsed.data.atendenteEmail ?? null;
      const atendenteUserId = parsed.data.atendenteUserId ?? null;
      const vendedorEmail = parsed.data.vendedorEmail ?? null;
      const assigneeEmail = parsed.data.assigneeEmail ?? null;
      const cliente = parsed.data.cliente ?? null;

      // ─── 1. A reunião nasce NO PAINEL ────────────────────────────────
      //
      // Mudança importante de desenho: quem gera o link do Meet é o PAINEL, não
      // a gente. O POST /api/ext/agenda/meetings cria a reunião, sorteia o
      // responsável pela regra de distribuição de lá, gera o Meet, põe na
      // agenda de quem vai conduzir, manda o .ics e avisa no Slack.
      //
      // Isso resolve de uma vez a distribuição, a disponibilidade e a
      // atribuição: são regras de negócio que já existem no painel e que
      // duplicar aqui só criaria duas verdades.
      //
      // O caminho do Google Calendar continua vivo como PLANO B, pra quando o
      // painel não está configurado (ou a reunião não tem os dados que ele
      // exige) — é o que mantém o botão útil em ambiente de teste.
      let meet: { meetUrl: string; eventId: string; meetingCode: string | null } | null = null;
      let painelMeetingId: string | null = null;
      let responsavel = atendenteEmail;
      /**
       * Preenchido quando o painel respondeu 5xx. A reunião acontece pelo plano
       * B, mas NÃO está registrada lá — e a resposta precisa dizer isso.
       */
      let painelIndisponivel: string | null = null;

      const dadosDoPainel = montarDadosDoPainel({
        tipo,
        atendenteEmail,
        vendedorEmail,
        assigneeEmail,
        cliente,
        contato,
        quando,
        // A conversa de onde a reunião saiu. É por ela que o resumo volta pro
        // atendimento certo quando a transcrição fica pronta — o painel pede
        // pra mandar sempre, e aqui a gente sempre sabe.
        chatproSessionId: sessionId,
      });

      if (painel?.estaConfigurado() && dadosDoPainel) {
        try {
          const criada = await painel.criarReuniao(dadosDoPainel);
          if (!criada.meetLink) {
            // Reunião criada mas sem link: repetir o POST duplicaria. Melhor
            // avisar e deixar a pessoa resolver no painel.
            res.status(502).json({
              error: 'O painel criou a reunião mas não gerou o link do Meet.',
              detail: `Reunião ${criada.id} — confira no painel antes de marcar de novo.`,
            });
            return;
          }
          meet = {
            meetUrl: criada.meetLink,
            eventId: criada.id,
            meetingCode: codigoDoMeet(criada.meetLink),
          };
          painelMeetingId = criada.id;
          responsavel = criada.responsavelEmail ?? atendenteEmail;
          log.info(
            `reunião ${criada.id} criada no painel (${criada.assignmentMode ?? 'modo?'}) ` +
              `para ${criada.responsavelNome ?? responsavel ?? '?'}.`
          );
        } catch (err) {
          const status = err instanceof PainelError ? err.status : 502;
          log.error('painel recusou a criação da reunião', err);

          // TIMEOUT (status 0) É DIFERENTE DE RECUSA, e confundir os dois custa
          // caro aqui. Abortar do nosso lado NÃO cancela o processamento do
          // lado de lá: o painel pode ter criado a reunião, gerado o Meet,
          // mandado o e-mail e avisado no Slack — e só a resposta se perdeu.
          //
          // A API não tem Idempotency-Key, então "tentar de novo" nesse estado
          // duplica um compromisso real na agenda de gente de verdade. A única
          // saída honesta é dizer que não sabemos e mandar conferir no painel.
          const incerto = status === 0;
          if (incerto) {
            res.status(504).json({
              error: 'Não sei dizer se a reunião foi marcada.',
              detail:
                `${errorMessage(err)} O painel pode tê-la criado e só a resposta se perdeu. ` +
                'Confira no painel ANTES de marcar de novo — repetir criaria uma reunião duplicada.',
              incerto: true,
              // A tela usa isto pra NÃO oferecer "tentar de novo".
              naoRepetir: true,
            });
            return;
          }

          // 409 = horário ocupado entre consultar a grade e confirmar. É
          // esperado, e a tela precisa saber pra recarregar os horários.
          if (status === 409) {
            res.status(409).json({
              error: 'Esse horário acabou de ser ocupado.',
              detail: errorMessage(err),
              recarregarHorarios: true,
            });
            return;
          }

          // 5xx: o painel está com problema DELE. Recusa de negócio (4xx) é
          // outra história e cai no `else` abaixo — ali a reunião não deve
          // mesmo acontecer, e insistir seria contornar a regra deles.
          //
          // Aqui não: o atendente está com o cliente na linha e o problema não
          // é dele nem do pedido. Então criamos o link por conta própria
          // (Google Calendar), mandamos pro cliente e gravamos igual — e
          // marcamos a reunião como PENDENTE DE REGISTRO no painel, pra
          // ninguém achar que ela está lá quando não está.
          //
          // O que NÃO fazemos: fingir que deu certo. A resposta diz, com todas
          // as letras, que a reunião não entrou no painel e precisa ser
          // lançada lá depois.
          if (status >= 500 || status === 0) {
            log.warn(
              `painel respondeu ${status} — caindo no plano B (link pelo Google). ` +
                'A reunião NÃO fica registrada no painel.'
            );
            painelIndisponivel = errorMessage(err);
          } else {
            res.status(502).json({
              error: 'O painel não conseguiu marcar a reunião.',
              detail: errorMessage(err),
            });
            return;
          }
        }
      }

      if (!meet) {
        // PLANO B: link na agenda de quem clicou, via Google Calendar.
        // `assigneeEmail` primeiro: quando a aba pôde escolher quem conduz, foi
        // ali que a escolha aconteceu. O `vendedorEmail` fica como segunda
        // opção porque, no fluxo antigo, era ele que carregava essa escolha.
        if (quando && tipo === 'apresentacao') {
          responsavel = assigneeEmail ?? vendedorEmail ?? atendenteEmail;
        }
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
            // Cobre os dois casos: nunca conectou, e conectou mas o token
            // venceu (ContaGoogleExpirada herda desta). A saída é a mesma.
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
      }

      // 2. A mensagem pro cliente.
      //
      //    Reunião AGORA: sai na hora, e se falhar PARA — um bot entrando numa
      //    sala que o cliente nem sabe que existe não ajuda ninguém.
      //
      //    Reunião AGENDADA: NÃO sai agora. O convite entra na fila durável e
      //    o worker dispara ~5 min antes do horário — link mandado dias antes
      //    se perde na conversa, e o cliente clicaria numa sala vazia. Se o
      //    "5 min antes" já passou (marcaram pra daqui a 3 min), sai já.
      const modelo =
        parsed.data.mensagem ?? (quando ? MENSAGEM_AGENDADA_PADRAO : MENSAGEM_PADRAO);
      // Agendada guarda o modelo com `{quando}` AINDA CRU: quem resolve é o
      // worker, no instante do envio. Congelar aqui produziria "amanhã às 10h"
      // chegando no próprio dia da reunião — o cliente entende o dia seguinte
      // e perde a reunião que começa em 5 minutos.
      // {tipo} e {responsavel} já dá pra resolver agora: não mudam com o tempo.
      // O {quando} é que fica cru nas agendadas, porque "amanhã" depende do dia
      // em que a mensagem for ENTREGUE, não do dia em que foi montada.
      const rotuloTipo = tipo ? ` ${ROTULO_DO_TIPO[tipo] ?? ''}`.trimEnd() : '';
      const nomeResponsavel = nomeDoResponsavel(responsavel);
      const comBase = modelo
        .replace('{tipo}', rotuloTipo)
        .replace('{responsavel}', nomeResponsavel ? `\ncom ${nomeResponsavel}` : '')
        .replace('{link}', meet.meetUrl);
      const texto = quando ? comBase : comBase.replace('{quando}', '');
      const enviarEm = quando
        ? new Date(Math.max(Date.now(), quando.getTime() - ANTECEDENCIA_CONVITE_MS))
        : null;
      // Falha no envio quando a reunião JÁ EXISTE no painel é o caso mais
      // delicado deste arquivo. A reunião foi criada de verdade: link gerado,
      // agenda do responsável ocupada, Slack avisado. Voltar um erro seco faz o
      // atendente clicar de novo — e o segundo clique cria uma SEGUNDA reunião
      // real, porque a API do painel não tem chave de idempotência.
      //
      // Então aqui a gente não desiste: registra a reunião, arma o bot e devolve
      // o link pra colar na mão. Se o atendente colar, o cliente entra e a
      // gravação acontece igual. O que não pode é refazer tudo.
      let mensagemFalhou: string | null = null;
      if (!quando) {
        const envio = await chatpro.enviarMensagem({ sessionId, message: texto, instanceId });
        if (!envio.ok) {
          mensagemFalhou = envio.motivo;
          if (!painelMeetingId) {
            // Sem reunião no painel (plano B), nada foi criado fora daqui:
            // parar é seguro e evita bot numa sala que o cliente não conhece.
            res.status(502).json({
              error: 'O link foi criado, mas não deu pra enviar pro cliente.',
              detail: envio.motivo,
              meetUrl: meet.meetUrl,
              hint: 'Você pode colar o link na conversa manualmente.',
            });
            return;
          }
          log.warn(
            `reunião ${painelMeetingId} existe no painel mas a mensagem não saiu ` +
              `(${envio.motivo}). Seguindo pra armar o bot — o atendente cola o link.`
          );
        }
      }

      // 3. Bot na sala — SE a gravação for nossa.
      //
      // Quando o painel grava, ele tem o próprio cron que cria o bot ~15 min
      // antes, sobrevive a reagendamento e garante um bot por reunião. Criar
      // outro aqui poria dois robôs na mesma sala. Então nem chamamos: a linha
      // local nasce só como registro do que foi marcado.
      const r = gravacaoPeloPainel
        ? registrarSemBot(db, {
            meetingUrl: meet.meetUrl,
            sessionId,
            chatproInstanceId: instanceId,
            atendenteEmail: responsavel,
            tipo,
            clienteJson: cliente ? JSON.stringify(cliente) : null,
            painelMeetingId,
            atendenteUserId,
          })
        : await criarReuniao(
        { db, recall, botName },
        {
          meetingUrl: meet.meetUrl,
          sessionId,
          chatproInstanceId: instanceId,
          origem: 'api',
          joinAt: quando,
          // Na coluna de atribuição vai o RESPONSÁVEL calculado, não
          // necessariamente quem clicou.
          atendenteEmail: responsavel,
          tipo,
          clienteJson: cliente ? JSON.stringify(cliente) : null,
          // O elo com o painel: é por ele que a transcrição volta pra lá no
          // fim da reunião. Sem isto, grava e não tem pra onde ir.
            painelMeetingId,
            atendenteUserId,
          }
        );

      // 4. Agendada: o convite entra na fila DEPOIS da reunião existir, pra
      //    carregar o meeting_id (é ele que cancela o convite se a reunião for
      //    desmarcada). Se o bot falhou a ponto de nem haver linha
      //    (RECALL_API_KEY vazia), o convite sai mesmo assim com um id órfão —
      //    o cliente receber o link importa mais que a gravação, e o worker
      //    não cancela por falta de reunião justamente por causa deste caso.
      if (quando && enviarEm) {
        db.criarEnvioAgendado({
          meetingId: r.meeting?.id ?? randomUUID(),
          sessionId,
          instanceId,
          message: texto,
          enviarEm: enviarEm.toISOString(),
          reuniaoEm: quando.toISOString(),
        });
      }

      // A reunião já nasceu registrada no painel (foi ele que a criou), então
      // não há um "registrar depois". O que fica pendente é a transcrição, que
      // sobe no fim da reunião via painel_meeting_id.

      log.info(
        `reunião ${quando ? `marcada pra ${quando.toISOString()}` : 'iniciada'} pela sessão ` +
          `${sessionId}: ${meet.meetingCode ?? '?'}, tipo ${tipo ?? '(sem tipo)'}, ` +
          `responsável ${responsavel ?? '(sem atendente)'}, bot ${r.ok ? 'ok' : 'FALHOU'}.`
      );

      res.status(201).json({
        meetUrl: meet.meetUrl,
        meetingCode: meet.meetingCode,
        // Agendada: a mensagem NÃO saiu agora — sai perto do horário.
        mensagemEnviada: !quando && mensagemFalhou === null,
        // A reunião EXISTE no painel. É o que impede a tela de oferecer
        // "tentar de novo" e duplicar um compromisso real.
        ...(painelMeetingId ? { painelMeetingId, naoRepetir: true } : {}),
        // O painel estava fora: a reunião aconteceu, mas NÃO está lá. Dizer
        // isso é o que separa "resolvi" de "escondi" — alguém precisa lançar
        // essa reunião no painel depois, e a tela tem que pedir isso.
        ...(painelIndisponivel
          ? {
              pendenteNoPainel: true,
              avisoPainel:
                'O painel de reuniões não respondeu, então a reunião foi criada por aqui: ' +
                'o link já existe e o cliente foi avisado, mas ela NÃO está registrada no ' +
                'painel. Lance manualmente por lá.',
              detalhePainel: painelIndisponivel,
            }
          : {}),
        ...(mensagemFalhou
          ? {
              avisoMensagem:
                `A reunião está marcada, mas a mensagem não chegou ao cliente ` +
                `(${mensagemFalhou}). Cole o link na conversa — não marque de novo, ` +
                'senão vira reunião duplicada.',
            }
          : {}),
        // Quem grava. A tela usa isto pra dizer a verdade em vez de prometer
        // uma gravação que não é nossa.
        gravando: r.ok,
        gravadoPeloPainel: gravacaoPeloPainel,
        // A extensão usa isto pra não abrir a sala de uma reunião que é depois.
        agendadaPara: quando ? quando.toISOString() : null,
        quandoTexto: quando ? formatarQuando(quando) : null,
        responsavel,
        ...(enviarEm ? { conviteAgendadoPara: enviarEm.toISOString() } : {}),
        ...(r.ok
          ? { meeting: resumirReuniao(r.meeting) }
          : {
              // Só é aviso quando a gravação era NOSSA e falhou. Com o painel
              // gravando não há bot daqui pra dar errado, e mostrar "o bot não
              // entrou" seria alarme falso em toda reunião.
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

/**
 * Grava a reunião SEM criar bot — o caminho de quando quem grava é o painel.
 *
 * A linha local continua existindo, e existe por três motivos concretos: o
 * convite agendado precisa de um `meeting_id` pra ser cancelado se a reunião
 * for desmarcada; o painel de revisão mostra o que foi marcado por aqui; e o
 * dia em que a gravação voltar pra cá não haverá um buraco no histórico.
 *
 * Devolve o mesmo formato de `criarReuniao` pra quem chama não precisar saber
 * qual dos dois caminhos rodou.
 */
function registrarSemBot(
  db: Db,
  entrada: {
    meetingUrl: string;
    sessionId: string;
    chatproInstanceId: string | null;
    atendenteEmail: string | null;
    tipo: string | null;
    clienteJson: string | null;
    painelMeetingId: string | null;
    atendenteUserId: string | null;
  }
): { ok: true; criada: true; meeting: MeetingRow } {
  const meeting = db.createMeeting({
    id: randomUUID(),
    botId: null,
    sessionId: entrada.sessionId,
    meetingUrl: entrada.meetingUrl,
    meetingCode: codigoDoMeet(entrada.meetingUrl),
    // 'done' e não 'created': 'created' é a reunião esperando um bot NOSSO, e
    // o worker de reconciliação iria atrás dele pra sempre. Aqui não há bot a
    // esperar — a gravação acontece do outro lado.
    status: 'done',
    botName: null,
    chatproInstanceId: entrada.chatproInstanceId,
    atendenteEmail: entrada.atendenteEmail,
    tipo: entrada.tipo,
    clienteJson: entrada.clienteJson,
    painelMeetingId: entrada.painelMeetingId,
    atendenteUserId: entrada.atendenteUserId,
  });
  // A transcrição virá do painel, não daqui: marcar como entregue evita que a
  // fila fique cutucando uma reunião que nunca vai ter transcript nosso.
  db.setMeetingChatproStatus(meeting.id, 'skipped-no-url', 0);
  return { ok: true, criada: true, meeting };
}

/**
 * O primeiro nome de quem vai conduzir, a partir do e-mail.
 *
 * O painel devolve o nome completo no 201, mas ele não chega até aqui em todos
 * os caminhos (plano B não passa pelo painel). O prefixo do e-mail resolve na
 * maioria dos casos — `anna.souza@` vira "Anna". E quando não der pra ter um
 * nome apresentável, a linha inteira some da mensagem em vez de sair torta.
 */
export function nomeDoResponsavel(email: string | null): string | null {
  if (!email || !email.includes('@')) return null;
  const local = email.split('@')[0] ?? '';
  const primeiro = local.split(/[._-]/)[0] ?? '';
  if (primeiro.length < 2 || /\d/.test(primeiro)) return null;
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

/** Código `abc-defg-hij` do link — é ele que casa a reunião com o bot. */
export function codigoDoMeet(url: string): string | null {
  const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url);
  return m ? (m[1] ?? '').toLowerCase() : null;
}

/**
 * Traduz o que a extensão mandou pro corpo que o painel espera.
 *
 * Devolve `null` quando falta algo que o painel EXIGE — aí o fluxo cai no
 * plano B (Google Calendar) em vez de levar 422 com o formulário cheio.
 *
 * Regras que moram aqui, todas vindas do contrato da API:
 * - data e hora vão SEPARADAS e em horário local BR (o servidor deriva o UTC);
 *   mandar instante UTC de um navegador em outro fuso marcaria na hora errada
 * - migração distingue `base` de `prospect`: são pools diferentes
 * - apresentação sempre vira `prospect` no banco do painel
 * - implantação e CS exigem `provedor`
 * - CS exige `cs_reason`
 * - migração exige `vendedor_email` (e checklist ativo pro CNPJ, que quem
 *   confere é o painel)
 */
export function montarDadosDoPainel(entrada: {
  tipo: string | null;
  atendenteEmail: string | null;
  vendedorEmail: string | null;
  assigneeEmail?: string | null;
  cliente: DadosCliente | null;
  contato: string | null;
  quando: Date | null;
  /** Conversa do chatPro — o elo que devolve o resumo ao atendimento. */
  chatproSessionId?: string | null;
}): DadosNovaReuniao | null {
  const { tipo, atendenteEmail, cliente } = entrada;
  if (!ehTipoReuniao(tipo) || !atendenteEmail) return null;

  // Nome e telefone do cliente: o formulário manda; sem ele, o que dá pra
  // aproveitar da conversa é o nome do contato.
  const nome = cliente?.nome ?? entrada.contato;
  const telefone = cliente?.telefone;
  const empresa = cliente?.empresa ?? nome;
  if (!nome || !telefone || !empresa) return null;

  // "Agora" é a reunião deste instante — a mesma data e hora locais.
  const inicio = entrada.quando ?? new Date();
  const { data, hora } = dataHoraLocal(inicio);

  const base: DadosNovaReuniao = {
    type: tipo,
    actorEmail: atendenteEmail,
    clientName: nome,
    companyName: empresa,
    phone: telefone,
    clientType: tipo === 'apresentacao' ? 'prospect' : (cliente?.clientType ?? 'base'),
    scheduledDate: data,
    scheduledTime: hora,
    ...(cliente?.cnpj ? { cnpj: cliente.cnpj } : {}),
    ...(cliente?.instancia ? { instanceCode: cliente.instancia } : {}),
    ...(cliente?.provedor ? { provedor: cliente.provedor } : {}),
    ...(cliente?.csReason ? { csReason: cliente.csReason } : {}),
    ...(entrada.vendedorEmail ? { vendedorEmail: entrada.vendedorEmail } : {}),
    ...(entrada.chatproSessionId ? { chatproSessionId: entrada.chatproSessionId } : {}),
    // Vai EXATAMENTE quando a aba mandou — e ela só manda quando o `/me`
    // liberou. Preencher aqui por conta própria (com o atendente, por exemplo)
    // daria 403 pra todo mundo que não é supervisor.
    ...(entrada.assigneeEmail ? { assigneeEmail: entrada.assigneeEmail } : {}),
    // É o e-mail que faz o painel mandar o convite com `.ics` pro cliente.
    ...(cliente?.email ? { clientEmail: cliente.email } : {}),
    ...(cliente?.oficialPlan ? { oficialPlan: cliente.oficialPlan } : {}),
    // Só quando é verdade: mandar `false` é ruído, e o painel já trata a
    // ausência como "pode mandar".
    ...(cliente?.semEmail ? { skipEmail: true } : {}),
  };

  // Implantação e CS não sobem sem provedor — o painel devolve 422.
  if ((tipo === 'implantacao' || tipo === 'cs') && !base.provedor) return null;

  // `cs_reason` (CS) e `vendedor_email` (migração) NÃO ganham uma trava dessas,
  // de propósito. Quem exige é o painel, e quem pede na tela é o formulário da
  // aba — que agora pede os dois. Repetir a regra aqui como desvio pro plano B
  // criaria a pior das saídas pra um pedido malformado: uma reunião que existe
  // pro cliente e não existe no painel, em silêncio. Sem a trava, o painel
  // recusa com 422 dizendo qual campo falta, e a aba mostra essa frase.
  return base;
}

/**
 * Data e hora LOCAIS (America/Sao_Paulo) no formato que o painel espera.
 * Usar getFullYear()/getHours() daria o fuso do servidor, que pode não ser o
 * do time comercial — e a reunião cairia na hora errada.
 */
export function dataHoraLocal(quando: Date): { data: string; hora: string } {
  const partes: Record<string, string> = {};
  for (const p of FORMATO_LOCAL.formatToParts(quando)) {
    if (p.type !== 'literal') partes[p.type] = p.value;
  }
  return {
    data: `${partes.year}-${partes.month}-${partes.day}`,
    hora: `${partes.hour}:${partes.minute}`,
  };
}

const FORMATO_LOCAL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
