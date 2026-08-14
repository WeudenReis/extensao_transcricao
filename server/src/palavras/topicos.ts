/**
 * Dicionário de TÓPICOS do domínio chatPro (atendimento via WhatsApp).
 *
 * É a única fonte que o motor de palavras-chave consulta — pra ajustar o que
 * o painel detecta, basta editar ESTA lista, sem tocar no motor. Por isso a
 * estrutura é deliberadamente simples: chave estável, rótulo pra exibição e
 * expressões em pt-BR do jeito que as pessoas realmente falam.
 *
 * Regras de escrita das expressões (o motor depende delas):
 * - Escreva SEM acento e em minúsculas: o motor normaliza a transcrição do
 *   mesmo jeito, então "migracao" casa com "migração", "Migração" etc.
 * - Cada expressão casa por PALAVRA INTEIRA ("api" não casa em "rapida").
 *   Por isso plural precisa ser listado ("relatorio" E "relatorios").
 * - Expressão com mais de uma palavra tolera espaços múltiplos entre elas.
 */

export interface TopicoDominio {
  /** Identificador estável (vai pro banco/JSON — não renomear à toa). */
  chave: string;
  /** Nome exibido no comentário e no painel. */
  rotulo: string;
  /** Expressões que denunciam o tópico, sem acento e em minúsculas. */
  expressoes: string[];
}

export const TOPICOS: TopicoDominio[] = [
  {
    chave: 'ia',
    rotulo: 'IA',
    expressoes: [
      'inteligencia artificial',
      'copiloto',
      'agente',
      'agentes',
      'chatbot',
      'bot de atendimento',
      'automacao',
      'automacoes',
    ],
  },
  {
    chave: 'distribuicao',
    rotulo: 'Distribuição de atendimento',
    expressoes: [
      'distribuicao',
      'distribuicao automatica',
      'distribuir atendimento',
      'distribuir atendimentos',
      'fila de atendimento',
      'rodizio',
    ],
  },
  {
    chave: 'oficial',
    rotulo: 'API Oficial',
    expressoes: [
      'api oficial',
      'whatsapp oficial',
      'cloud api',
      'meta',
      'numero verificado',
      'selo',
    ],
  },
  {
    chave: 'multiatendimento',
    rotulo: 'Multiatendimento',
    expressoes: [
      'varios atendentes',
      'multi atendimento',
      'multiatendimento',
      'equipe',
      'equipes',
    ],
  },
  {
    chave: 'migracao',
    rotulo: 'Migração',
    expressoes: [
      'migrar',
      'migracao',
      'trocar de plataforma',
      'importar contatos',
    ],
  },
  {
    chave: 'preco',
    rotulo: 'Preço',
    expressoes: [
      'preco',
      'precos',
      'valor',
      'valores',
      'mensalidade',
      'plano',
      'planos',
      'desconto',
      'quanto custa',
    ],
  },
  {
    chave: 'integracao',
    rotulo: 'Integrações',
    expressoes: [
      'api',
      'webhook',
      'webhooks',
      'integrar',
      'integracao',
      'integracoes',
      'crm',
      'sistema',
    ],
  },
  {
    chave: 'relatorios',
    rotulo: 'Relatórios',
    expressoes: [
      'relatorio',
      'relatorios',
      'dashboard',
      'metrica',
      'metricas',
      'indicador',
      'indicadores',
    ],
  },
  {
    chave: 'agendamento',
    rotulo: 'Agendamento de mensagens',
    expressoes: [
      'agendar mensagem',
      'agendar mensagens',
      'disparo',
      'disparos',
      'campanha',
      'campanhas',
    ],
  },
];
