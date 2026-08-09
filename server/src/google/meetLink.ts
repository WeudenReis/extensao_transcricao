import { createLogger } from '../log.js';

/**
 * Cria um link do Google Meet.
 *
 * Caminho usado: **Calendar API**, criando um evento com
 * `conferenceData.createRequest` e `conferenceDataVersion=1`. O link do Meet
 * sai como efeito colateral do evento.
 *
 * Por que não o Meet REST API v2 (`spaces.create`): ele depende de edição do
 * Google Workspace, e aqui todo mundo usa **conta pessoal @gmail** — foi o que
 * derrubou o caminho anterior deste projeto. O Calendar funciona nas duas.
 *
 * O evento nasce na agenda de quem clicou, curto e sem convidados: ele existe
 * pra carregar o link, não pra virar compromisso na agenda de ninguém.
 *
 * A exceção é a reunião MARCADA (`inicio` no futuro): aí o evento é o
 * compromisso, cai no horário certo da agenda e ganha lembrete.
 */

const log = createLogger('google/meetLink');

const CALENDAR_PADRAO = 'https://www.googleapis.com';
/** Sobrescreve a base do Google (só pra teste de ponta a ponta contra stub). */
export const CALENDAR_BASE = process.env.GOOGLE_CALENDAR_BASE_URL || CALENDAR_PADRAO;
const CALENDAR_EVENTS = `${CALENDAR_BASE}/calendar/v3/calendars/primary/events`;
const TIMEOUT_MS = 20_000;

/** Duração nominal do evento. Não limita a reunião — o Meet segue aberto. */
const DURACAO_MINUTOS = 60;

/**
 * Teto da duração nominal. Um evento de dias na agenda de quem clicou seria
 * ruído puro — e o valor vem de fora, então precisa de um limite.
 */
const DURACAO_MAXIMA_MINUTOS = 12 * 60;

/**
 * Antecedência a partir da qual o evento vira compromisso de verdade e ganha
 * lembrete. Abaixo disso a pessoa já está indo pra reunião; o pop-up só
 * atrapalharia.
 */
const LEMBRETE_MINUTOS = 10;

export class MeetLinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = 'MeetLinkError';
  }
}

export interface MeetCriado {
  meetUrl: string;
  eventId: string;
  /** Código `abc-defg-hij`, útil pra casar com a reunião depois. */
  meetingCode: string | null;
}

export interface CriarMeetOptions {
  accessToken: string;
  /** Vira o título do evento na agenda do atendente. */
  titulo: string;
  /**
   * Quando a reunião começa. Sem isto o evento nasce agora — que é o clique
   * normal do atendente, e continua sendo o comportamento padrão.
   */
  inicio?: Date;
  /** Duração nominal do evento na agenda. Fora de faixa cai no padrão/teto. */
  duracaoMinutos?: number;
  /** Injetável nos testes. */
  fetchImpl?: typeof fetch;
  /** Injetável nos testes (o requestId precisa ser único por evento). */
  requestId?: string;
  agora?: () => Date;
}

function codigoDaUrl(url: string): string | null {
  const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url);
  return m ? (m[1] ?? '').toLowerCase() : null;
}

/** Procura o link do Meet na resposta do Calendar, cobrindo as duas formas. */
export function extrairMeetUrl(evento: unknown): string | null {
  if (evento === null || typeof evento !== 'object') return null;
  const e = evento as Record<string, unknown>;

  // Forma 1: atalho `hangoutLink`.
  if (typeof e.hangoutLink === 'string' && e.hangoutLink !== '') return e.hangoutLink;

  // Forma 2: entryPoints do conferenceData (é a canônica).
  const conf = e.conferenceData as Record<string, unknown> | undefined;
  const pontos = conf?.entryPoints;
  if (Array.isArray(pontos)) {
    for (const p of pontos) {
      const ponto = p as Record<string, unknown>;
      if (ponto.entryPointType === 'video' && typeof ponto.uri === 'string' && ponto.uri !== '') {
        return ponto.uri;
      }
    }
  }
  return null;
}

/** Duração pedida, quando faz sentido; senão o padrão. */
function duracaoEmMinutos(pedida: number | undefined): number {
  if (pedida === undefined || !Number.isFinite(pedida) || pedida <= 0) return DURACAO_MINUTOS;
  return Math.min(pedida, DURACAO_MAXIMA_MINUTOS);
}

export async function criarLinkDoMeet(options: CriarMeetOptions): Promise<MeetCriado> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const agora = options.agora?.() ?? new Date();
  const inicio = options.inicio ?? agora;
  const duracao = duracaoEmMinutos(options.duracaoMinutos);
  const fim = new Date(inicio.getTime() + duracao * 60_000);
  // Reunião marcada é compromisso; a de agora é só um link que precisa existir.
  const agendada = inicio.getTime() - agora.getTime() >= LEMBRETE_MINUTOS * 60_000;

  const corpo = {
    summary: options.titulo,
    description:
      'Reunião criada pelo chatPro. A gravação é feita por um participante ' +
      'identificado na chamada.',
    start: { dateTime: inicio.toISOString() },
    end: { dateTime: fim.toISOString() },
    // O requestId precisa ser único por evento: reaproveitar conferência entre
    // eventos diferentes expõe reunião pra quem não devia (aviso do Google).
    conferenceData: {
      createRequest: {
        requestId: options.requestId ?? `chatpro-${agora.getTime()}-${Math.trunc(agora.getTime() % 9973)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    // Sem convidados e sem e-mail: o evento existe pra gerar o link. Quando é
    // marcado pra depois ele também precisa lembrar o atendente — evento futuro
    // sem lembrete é reunião perdida.
    reminders: agendada
      ? { useDefault: false, overrides: [{ method: 'popup', minutes: LEMBRETE_MINUTOS }] }
      : { useDefault: false },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetchImpl(`${CALENDAR_EVENTS}?conferenceDataVersion=1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
      signal: controller.signal,
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new MeetLinkError(
        `Google Calendar respondeu HTTP ${resposta.status}`,
        resposta.status,
        detalhe.slice(0, 400)
      );
    }

    const evento: unknown = await resposta.json();
    const meetUrl = extrairMeetUrl(evento);
    if (!meetUrl) {
      // O Google gera a conferência de forma assíncrona; normalmente já vem
      // pronta, mas se não vier não adianta seguir com link vazio.
      throw new MeetLinkError(
        'O Calendar criou o evento mas não devolveu o link do Meet. ' +
          'Confira se a conta tem o Meet habilitado.',
        200,
        ''
      );
    }

    const eventId =
      typeof (evento as Record<string, unknown>).id === 'string'
        ? ((evento as Record<string, unknown>).id as string)
        : '';
    log.info(
      `link do Meet criado (evento ${eventId || '?'}) para ${inicio.toISOString()}, ` +
        `${duracao} min.`
    );
    return { meetUrl, eventId, meetingCode: codigoDaUrl(meetUrl) };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new MeetLinkError(
        `Google Calendar não respondeu em ${Math.round(TIMEOUT_MS / 1000)} s.`,
        0,
        ''
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
