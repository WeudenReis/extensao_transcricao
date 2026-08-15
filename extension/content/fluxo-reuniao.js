/**
 * O fluxo de marcar reunião, passo a passo, dentro da aba lateral.
 *
 * A ordem é a do atendente, não a da API:
 *
 *   quem sou eu (painel /me)
 *     → agora ou marcar
 *       → tipo (só os que ESTE atendente pode)
 *         → dados do cliente
 *           → [marcar] dia e horário, da grade real do painel
 *             → confirmação
 *
 * O formulário é desenhado a partir do `/me`: o painel responde quais tipos a
 * pessoa pode marcar, como cada um é atribuído (`self`, `round_robin`,
 * `explicit`) e se ela escolhe o responsável. Oferecer tudo a todo mundo e
 * deixar o 403 aparecer com o formulário preenchido seria trabalho jogado fora.
 */

(() => {
  'use strict';

  // Só o rótulo: cor literal aqui era o que quebrava a aba na troca de tema.
  // Quem pinta é o design system do chatPro, pelas classes do Copiloto.
  const TIPOS = {
    apresentacao: { rotulo: 'Apresentação' },
    migracao: { rotulo: 'Migração' },
    implantacao: { rotulo: 'Implantação' },
    cs: { rotulo: 'CS' },
  };
  /** Estes três não sobem sem os dados cadastrais do cliente. */
  const COM_DADOS = ['migracao', 'implantacao', 'cs'];
  const PROVEDORES = [
    ['starter', 'Starter'],
    ['cloud_api', 'Cloud API'],
    ['api_disparos', 'API de disparos'],
  ];
  /**
   * Plano Oficial contratado (`oficial_plan`) — só a migração usa, e é
   * opcional. Os valores vieram do próprio 422 da API, não de suposição:
   * "expected one of oficial_1|oficial_2|oficial_3|base_sem_creditos".
   * Os créditos nos rótulos são os da tela do painel.
   */
  const PLANOS_OFICIAL = [
    ['oficial_1', 'Oficial 1 — 500 créditos'],
    ['oficial_2', 'Oficial 2 — 1000 créditos'],
    ['oficial_3', 'Oficial 3 — 2000 créditos'],
    ['base_sem_creditos', 'Sem adição de créditos — Base'],
  ];
  /**
   * Motivos que o CS aceita (`cs_reason`). Sem um deles a API devolve 422 — e
   * até hoje a pessoa só descobria isso depois de preencher o formulário todo.
   */
  const MOTIVOS_CS = [
    ['treinamento_ia', 'Treinamento de IA'],
    ['treinamento_chat', 'Treinamento do Chat'],
    ['treinamento_oficial', 'Treinamento do Oficial'],
    ['retencao', 'Retenção'],
    ['duvidas', 'Dúvidas'],
  ];
  /** O painel recusa migração sem checklist — e recusa com esta frase. */
  const SEM_CHECKLIST =
    'Nenhum checklist de migração ativo para este CNPJ. ' +
    'Gere o link do onboarding antes de agendar.';

  // ─── Máscaras e validação ──────────────────────────────────────────────────
  //
  // A máscara antiga só existia no evento `input` e só sabia ler dígito por
  // dígito. Colar é outro caminho, e é o caminho de verdade: o dado vem de
  // planilha, de e-mail, do cadastro — com aspas de CSV, tabulação, quebra de
  // linha, "+55", "0055", pontuação de outro formato — e pode cair NO MEIO de
  // um valor que já estava no campo.
  //
  // Por isso aqui há dois eventos (`paste` e `input`) apontando pra MESMA
  // normalização, e o cursor é ancorado em DÍGITOS, nunca em posição de
  // caractere: a pontuação da máscara entra e sai a cada tecla, então "estava
  // no caractere 7" não sobrevive à formatação — "estava depois do 5º dígito",
  // sim.

  function comoTexto(v) {
    return v == null ? '' : String(v);
  }

  function soDigitos(v) {
    return comoTexto(v).replace(/\D+/g, '');
  }

  /**
   * Tira o lixo das PONTAS de um valor colado: aspas do CSV, tabulação da
   * célula, quebra de linha, espaço. Só das pontas — o miolo é problema da
   * máscara, e mexer nele aqui destruiria um número internacional.
   */
  function limparPontas(v) {
    return comoTexto(v).replace(/^[\s"'`]+/, '').replace(/[\s"'`,;.]+$/, '');
  }

  function contarDigitos(v) {
    const achados = comoTexto(v).match(/\d/g);
    return achados ? achados.length : 0;
  }

  /** Posição logo depois do n-ésimo dígito — é a âncora do cursor. */
  function posDepoisDeNDigitos(t, n) {
    if (n <= 0) return 0;
    let vistos = 0;
    for (let i = 0; i < t.length; i += 1) {
      const c = t.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        vistos += 1;
        if (vistos >= n) return i + 1;
      }
    }
    return t.length;
  }

  function mascararCnpj(v) {
    const d = soDigitos(v).slice(0, 14);
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
    if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
    if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  function mascararTelefone(v) {
    const d = soDigitos(v).slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  /**
   * CNPJ: entra como vier, sai sempre `00.000.000/0000-00`.
   *
   * `prefixo` é quantos dígitos foram comidos NA FRENTE do valor — o CNPJ nunca
   * perde nenhum (o corte é no fim, no 14º), mas quem posiciona o cursor lê
   * este campo dos dois formatadores, então ele existe aqui também.
   */
  function formatarCnpj(bruto) {
    return { texto: mascararCnpj(bruto), prefixo: 0 };
  }

  /**
   * Telefone: aceita `62999998888`, `(62) 99999-8888`, `62 9 9999-8888`,
   * `+55 62 99999-8888`, `5562999998888`, `0062...` — e devolve
   * `(00) 00000-0000` ou `(00) 0000-0000`.
   *
   * Duas decisões que parecem detalhe e não são:
   *
   *  - o `55` só sai quando o que SOBRA tem 10 ou 11 dígitos. DDD 55 existe
   *    (Santa Maria/RS): `55 99999-8888` são 11 dígitos e é número local, não
   *    DDI. Cortar por "começa com 55" apagaria o DDD de uma região inteira.
   *  - número de outro país volta como veio (`intocado`). Aplicar máscara
   *    brasileira em `+1 415 555 2671` não deixa o campo mais bonito, deixa o
   *    telefone errado.
   */
  function formatarTelefone(bruto) {
    const limpo = limparPontas(bruto);
    const internacional = limpo.charAt(0) === '+';
    let d = soDigitos(limpo);
    let prefixo = 0;

    // Nenhum número brasileiro começa com zero: o que aparece na frente é
    // prefixo de discagem (`00` internacional, `0` da antiga operadora).
    while (d.length > 11 && d.charAt(0) === '0') {
      d = d.slice(1);
      prefixo += 1;
    }
    if ((d.length === 12 || d.length === 13) && d.slice(0, 2) === '55') {
      d = d.slice(2);
      prefixo += 2;
    }

    // Sobrou coisa demais pra caber num número brasileiro, ou a pessoa escreveu
    // o DDI de outro país: devolve como veio.
    if (d.length > 11 || (internacional && prefixo === 0)) {
      return { texto: limpo, prefixo: 0, intocado: true };
    }
    return { texto: mascararTelefone(d), prefixo };
  }

  /**
   * Liga a formatação automática num campo, pelos DOIS caminhos.
   *
   * `paste` com `preventDefault`: o navegador colaria o texto cru e só depois
   * dispararia `input` — daria pra formatar lá, mas o valor bruto pisca na tela
   * e o cursor já teria ido pro fim. Aqui a inserção é nossa, então o texto
   * colado nunca aparece sem formato.
   *
   * `input` cobre o resto: digitar, arrastar-e-soltar, autocompletar do
   * navegador, e o próprio `paste` nos navegadores em que o preventDefault não
   * pega.
   */
  function instalarFormatacao(campo, formatar, aoFormatar) {
    const entrada = campo.entrada;
    // O que estava no campo ANTES da tecla atual — é como se descobre que o
    // backspace comeu só a pontuação da máscara.
    let anterior = entrada.value;

    function aplicar(bruto, digitosAntes, forcar) {
      const r = formatar(bruto);

      // Valor que a formatação não reconhece (internacional): ele é da pessoa,
      // não nosso. Digitando, não encostamos — senão o espaço que ela acabou de
      // digitar sumiria no meio da digitação. Colando, gravamos, porque demos
      // preventDefault e o navegador não vai gravar por nós.
      if (r.intocado && !forcar) {
        anterior = entrada.value;
        if (aoFormatar) aoFormatar(entrada.value);
        return;
      }

      const novo = r.texto;
      if (novo !== entrada.value) entrada.value = novo;
      const alvo = Math.max(0, digitosAntes - r.prefixo);
      const pos = posDepoisDeNDigitos(novo, alvo);
      try {
        entrada.setSelectionRange(pos, pos);
      } catch (_erro) {
        // Campo que não aceita seleção (alguns tipos): formatar já valeu.
      }
      anterior = novo;
      if (aoFormatar) aoFormatar(novo);
    }

    entrada.addEventListener('paste', (ev) => {
      const area = ev.clipboardData || window.clipboardData;
      if (!area) return;
      const colado = area.getData('text');
      if (!colado) return;
      ev.preventDefault();

      // Colar NO MEIO tem que funcionar: o que vale é o campo inteiro depois da
      // inserção, não o pedaço colado sozinho.
      const valor = entrada.value;
      const ini = entrada.selectionStart == null ? valor.length : entrada.selectionStart;
      const fim = entrada.selectionEnd == null ? ini : entrada.selectionEnd;
      const antes = valor.slice(0, ini);
      const depois = valor.slice(fim);
      const combinado = antes + colado + depois;
      aplicar(combinado, contarDigitos(antes + colado), true);
    });

    entrada.addEventListener('input', (ev) => {
      const bruto = entrada.value;
      const caret = entrada.selectionStart == null ? bruto.length : entrada.selectionStart;
      const digitosAntes = contarDigitos(bruto.slice(0, caret));
      const apagouPraTras = Boolean(ev && ev.inputType === 'deleteContentBackward');

      // Backspace em cima da pontuação da máscara: a contagem de dígitos não
      // mudou, então a máscara devolveria a pontuação e o cursor ficaria
      // parado — dá a impressão de que a tecla travou. Come o dígito anterior,
      // que é o que a pessoa quis apagar.
      if (apagouPraTras && digitosAntes > 0 && soDigitos(bruto) === soDigitos(anterior)) {
        const todos = soDigitos(bruto);
        aplicar(todos.slice(0, digitosAntes - 1) + todos.slice(digitosAntes), digitosAntes - 1);
        return;
      }

      aplicar(bruto, digitosAntes);
    });

    // Último passe ao sair do campo: pega o que entrou sem evento nenhum
    // (autofill de gerenciador de senhas, script de terceiro).
    entrada.addEventListener('blur', () => {
      aplicar(entrada.value, contarDigitos(entrada.value));
    });

    // Valor que já estava no campo (pré-preenchido pela conversa) entra
    // formatado, sem esperar a pessoa encostar nele.
    //
    // Em microtarefa porque quem monta o campo ainda vai declarar, logo abaixo,
    // as variáveis que o callback usa — chamar agora esbarraria nelas antes da
    // hora. Microtarefa roda antes de o navegador pintar, então ninguém vê o
    // valor cru.
    if (entrada.value) {
      const inicial = entrada.value;
      void Promise.resolve().then(() => {
        if (entrada.value !== inicial) return;
        aplicar(inicial, contarDigitos(inicial), true);
      });
    }
  }

  /**
   * A rota do CNPJ está sendo escrita agora, por outro agente. Ler vários nomes
   * de campo é de propósito: se o corpo vier com `razao_social`, ou aninhado em
   * `cliente`/`dados`, o campo Empresa preenche do mesmo jeito em vez de ficar
   * em silêncio esperando alguém notar.
   */
  function razaoSocialDe(resposta) {
    if (!resposta || typeof resposta !== 'object') return null;
    const fontes = [resposta, resposta.cliente, resposta.dados, resposta.data, resposta.empresa];
    const chaves = [
      'razaoSocial',
      'razao_social',
      'nomeEmpresarial',
      'nome_empresarial',
      'razao',
      'nomeFantasia',
      'nome_fantasia',
      'nome',
    ];
    for (const fonte of fontes) {
      if (!fonte || typeof fonte !== 'object') continue;
      for (const chave of chaves) {
        const v = fonte[chave];
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
      }
    }
    // `empresa` como string simples é o formato mais provável de todos.
    if (typeof resposta.empresa === 'string' && resposta.empresa.trim() !== '') {
      return resposta.empresa.trim();
    }
    return null;
  }

  /**
   * CNPJ pelos dígitos verificadores. O painel usa o CNPJ como chave do
   * checklist de migração: um dígito trocado não devolve "não achei", devolve
   * o checklist de OUTRA empresa.
   */
  function cnpjValido(bruto) {
    const n = bruto.replace(/\D/g, '');
    if (n.length !== 14 || /^(\d)\1{13}$/.test(n)) return false;
    const dig = (base, pesos) => {
      const soma = pesos.reduce((a, peso, i) => a + Number(base[i]) * peso, 0);
      const r = soma % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return (
      Number(n[12]) === dig(n, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) &&
      Number(n[13]) === dig(n, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    );
  }

  // ─── Conversa com o servidor ───────────────────────────────────────────────

  function pedir(tipo, dados) {
    return chrome.runtime.sendMessage(Object.assign({ tipo }, dados || {}));
  }

  function hojeLocal(offsetDias) {
    const d = new Date();
    d.setDate(d.getDate() + (offsetDias || 0));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * `2026-08-17` + `09:00` → `2026-08-17T09:00:00-03:00`.
   *
   * O offset é obrigatório no servidor, e o motivo é concreto: sem ele a data
   * é lida como UTC e o cliente recebe um horário três horas antes do
   * combinado. Sai do próprio navegador (`getTimezoneOffset`), então acompanha
   * horário de verão e quem estiver em outro fuso.
   */
  function comFuso(data, hora) {
    const minutos = -new Date(`${data}T${hora}:00`).getTimezoneOffset();
    const sinal = minutos >= 0 ? '+' : '-';
    const abs = Math.abs(minutos);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${data}T${hora}:00${sinal}${hh}:${mm}`;
  }

  function diaLegivel(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    const data = new Date(a, m - 1, d);
    const semana = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    return `${semana[data.getDay()]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  }

  // ─── A tira de dias (passo do horário) ─────────────────────────────────────
  //
  // Tudo daqui até `estiloDoSeletorDeDia` existe só pro seletor de dia, que
  // agora é uma tira horizontal como a do painel de reuniões.

  const SEMANA_CURTA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  const MES_CURTO = [
    'jan',
    'fev',
    'mar',
    'abr',
    'mai',
    'jun',
    'jul',
    'ago',
    'set',
    'out',
    'nov',
    'dez',
  ];

  /**
   * ISO → `Date` LOCAL, componente a componente.
   *
   * `new Date('2026-08-15')` é lido como UTC: a oeste de Greenwich isso volta
   * 14/08 às 21h, e a tira inteira ficaria um dia atrasada — inclusive o dia da
   * semana escrito no cartão.
   */
  function dataLocal(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(a, m - 1, d);
  }

  function isoDe(data) {
    const p = (n) => String(n).padStart(2, '0');
    return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}`;
  }

  /** Somar pela `Date` e não pela string: ela vira o mês e o ano sozinha. */
  function somarDias(iso, n) {
    const d = dataLocal(iso);
    d.setDate(d.getDate() + n);
    return isoDe(d);
  }

  /**
   * Sábado e domingo não têm grade comercial. Fora da tira eles não gastam nem
   * chamada nem espaço — e era justamente clicar num sábado, ler "sem horário
   * livre" e ter que adivinhar o próximo dia que fazia a tela antiga doer.
   */
  function ehDiaUtil(iso) {
    const dia = dataLocal(iso).getDay();
    return dia !== 0 && dia !== 6;
  }

  /** As três linhas do cartão de dia: SEX · 14 · ago. */
  function partesDoDia(iso) {
    const d = dataLocal(iso);
    return {
      semana: SEMANA_CURTA[d.getDay()],
      numero: String(d.getDate()),
      mes: MES_CURTO[d.getMonth()],
    };
  }

  const ID_ESTILO_DIAS = 'cpm-estilo-dias';

  /**
   * O CSS da tira de dias. Mora aqui, e não em `aba-reuniao.js`, porque é só
   * deste passo.
   *
   * Toda cor sai de token — `hsl(var(--gray-XX))`, `hsl(var(--cool-green-70))`.
   * As `--gray-*` INVERTEM entre o tema claro e o escuro: cor literal (hex ou
   * funcional) aqui deixaria a tira ilegível no claro, que é bug já corrigido
   * uma vez nesta aba e não pode voltar.
   *
   * O dia escolhido é borda + fundo verde translúcido, não verde chapado: sobre
   * o verde do chatPro precisaria de uma cor de texto fixa pra ter contraste, e
   * cor fixa é exatamente o que não pode existir aqui.
   */
  function estiloDoSeletorDeDia() {
    if (document.getElementById(ID_ESTILO_DIAS)) return;
    const st = document.createElement('style');
    st.id = ID_ESTILO_DIAS;
    st.textContent = `
.copilot--reuniao .cpm-rotulo{
  display:block;margin:0 0 .375rem;font-size:.8125rem;color:hsl(var(--gray-50))}
.copilot--reuniao .cpm-secao{margin-top:1rem}

/* ── A tira ── */
/* Sem barra de rolagem: numa coluna de 450px ela ocupa espaço, some e volta
   conforme o número de dias, e ficou feia na tela. Os dias entram em GRADE e
   quebram linha sozinhos; quem quiser mais dias usa o botão, que é explícito.
   O overflow fica escondido em vez de rolável pelo mesmo motivo. */
.copilot--reuniao .cpm-dias{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(4.25rem,1fr));
  gap:.5rem;padding:2px}
/* O dia escolhido é PREENCHIDO de verde vivo, com texto escuro — é assim no
   painel. Um tingido translúcido some no meio dos outros; o preenchido é o que
   deixa claro qual dia está valendo.

   O verde é --lime-green-50 (167 100% 40%), não --cool-green-70: aquele é o
   teal apagado dos botões secundários, e o painel usa o vivo na seleção. */
.copilot--reuniao .cpm-dia{
  min-width:0;padding:.5rem .375rem .4375rem;
  display:flex;flex-direction:column;align-items:center;gap:.0625rem;
  border:1px solid hsl(var(--gray-10));border-radius:var(--radius-md);
  background:hsl(var(--gray-00));color:hsl(var(--gray-80));
  font-family:inherit;cursor:pointer;transition:all .1s}
.copilot--reuniao .cpm-dia:hover:not([disabled]){
  border-color:hsl(var(--gray-20));background:hsl(var(--gray-05))}
.copilot--reuniao .cpm-dia[disabled]{cursor:default;opacity:.45}
.copilot--reuniao .cpm-dia--escolhido,
.copilot--reuniao .cpm-dia--escolhido:hover{
  background:hsl(var(--lime-green-50));border-color:hsl(var(--lime-green-50));
  color:hsl(var(--gray-00))}
.copilot--reuniao .cpm-dia-semana{
  font-size:.625rem;font-weight:600;letter-spacing:.04em;
  text-transform:uppercase;color:hsl(var(--gray-50))}
.copilot--reuniao .cpm-dia-num{font-size:1.25rem;font-weight:700;line-height:1.1}
.copilot--reuniao .cpm-dia-mes{font-size:.625rem;color:hsl(var(--gray-50))}
.copilot--reuniao .cpm-dia-vagas{
  font-size:.625rem;white-space:nowrap;color:hsl(var(--gray-50));margin-top:.125rem}
/* No dia escolhido tudo herda o escuro do fundo verde. */
.copilot--reuniao .cpm-dia--escolhido .cpm-dia-semana,
.copilot--reuniao .cpm-dia--escolhido .cpm-dia-mes,
.copilot--reuniao .cpm-dia--escolhido .cpm-dia-vagas{color:hsl(var(--gray-00))}

/* ── Esqueleto: são 7 chamadas, a tira não pode ficar em branco ── */
.copilot--reuniao .cpm-esqueleto{
  min-width:2.5rem;height:.5rem;margin:.125rem 0;border-radius:var(--radius-sm);
  background:hsl(var(--gray-10));animation:cpm-pulsa 1.1s ease-in-out infinite}
@keyframes cpm-pulsa{0%,100%{opacity:1}50%{opacity:.35}}

/* ── Ações abaixo da tira ── */
.copilot--reuniao .cpm-dias-acoes{display:flex;flex-wrap:wrap;gap:.5rem}
.copilot--reuniao .cpm-dias-acoes .button{height:2rem;padding:0 .75rem;font-size:.75rem}
.copilot--reuniao .cpm-recado{
  margin:.625rem 0 0;font-size:.75rem;line-height:1.5;color:hsl(var(--gray-50))}

/* O horário escolhido é estilizado na folha da aba (aba-reuniao.js), junto com
   .cpm-horario — preenchido de --lime-green-50, igual ao dia. Repetir a regra
   aqui sobrescrevia aquilo com um tingido, e as duas seleções ficavam
   diferentes uma da outra. */

@media (prefers-reduced-motion:reduce){
  .copilot--reuniao .cpm-esqueleto{animation:none}}
`;
    document.head.appendChild(st);
  }

  /**
   * Enche um `<select>` do formulário — o elemento já vem com a classe `.input`
   * do chatPro, então aqui só entram as opções.
   *
   * `vazio` cria a opção em branco no topo. Ela existe pra obrigar uma escolha
   * consciente: sem ela o navegador já deixa a PRIMEIRA opção marcada, e um
   * motivo de CS errado é pior que um campo vazio — o formulário sobe, o painel
   * aceita, e a reunião fica classificada como outra coisa.
   */
  function opcoesDo(campo, pares, vazio) {
    if (vazio) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = vazio;
      campo.entrada.appendChild(o);
    }
    for (const [valor, rotulo] of pares) {
      const o = document.createElement('option');
      o.value = valor;
      o.textContent = rotulo;
      campo.entrada.appendChild(o);
    }
    return campo;
  }

  // ─── O fluxo ───────────────────────────────────────────────────────────────

  function iniciar(contexto) {
    const aba = window.__cpmAba;

    // Aqui existia um ouvinte de `cpm-aba-remontar`, da época em que a aba
    // media o layout e se remontava ao trocar entre empurrar e sobrepor. A aba
    // virou um `.copilot` de verdade (quem cuida do tamanho é o CSS do chatPro,
    // e o React que remove o nó é coberto pelo MutationObserver de
    // `aba-reuniao.js`), então NINGUÉM dispara mais esse evento — o ouvinte
    // ficou órfão. Pior: ele chamava o passo guardado em `iniciar.passoAtual`,
    // que é a função da abertura ANTERIOR, presa ao `api` de um DOM já
    // removido — o clique não teria efeito nenhum na aba nova.
    //
    // A conversa é travada AQUI, no começo. Entre abrir a aba e confirmar, o
    // atendente pode clicar numa notificação e cair em outra conversa — sem a
    // trava, os dados do cliente A criariam a reunião do cliente B.
    const sessaoOrigem = contexto.sessionId;

    aba.abrir((api) => {
      const estado = {
        eu: null,
        modo: null,
        tipo: null,
        cliente: null,
        data: null,
        hora: null,
        /** `vendedor_email`: o dono da conta. Migração exige. */
        vendedorEmail: null,
        /** `assignee_email`: quem conduz. Só sai quando o painel permite. */
        assigneeEmail: null,
        /** Faltando painel ou e-mail: a tela roda, mas nada é marcado de verdade. */
        previa: false,
        semAtendente: false,
      };

      // ── Passo 0: quem é o atendente ──────────────────────────────────────
      async function passoIdentidade() {
        api.cabecalho('Reunião', null);
        api.carregando('Identificando você no painel…');

        const atendente = window.__cpmAtendente.detectar();
        if (!atendente.email) {
          // Sem e-mail não dá pra ATRIBUIR, mas dá pra conferir a tela. Segue
          // em prévia com um aviso — travar aqui esconderia o resto do fluxo
          // de quem só quer ver como ficou.
          console.log('[chatPro reunião] chaves encontradas:', window.__cpmAtendente.diagnosticar());
          estado.semAtendente = true;
          atendente.email = null;
        } else {
          console.log(`[chatPro reunião] atendente: ${atendente.email} (via ${atendente.via})`);
        }

        if (!atendente.email) {
          estado.eu = {
            email: null,
            nome: null,
            papel: null,
            capacidades: Object.keys(TIPOS).map((t) => ({
              type: t,
              allowed: true,
              assignment: t === 'apresentacao' ? 'self' : 'round_robin',
              can_choose_assignee: t === 'apresentacao',
            })),
          };
          estado.previa = true;
          passoModo();
          return;
        }

        let resposta;
        try {
          resposta = await pedir('PAINEL_ME', { email: atendente.email });
        } catch (err) {
          const texto = String((err && err.message) || err);
          // "Extension context invalidated" NÃO é o painel recusando ninguém:
          // é a extensão ter sido recarregada com esta aba ainda rodando o
          // script antigo. O canal com o service worker morreu, e nenhuma
          // chamada vai funcionar até dar F5. Confundir os dois mandava a
          // pessoa investigar o cadastro dela no painel, que está certo.
          if (/context invalidated|receiving end does not exist|message port closed/i.test(texto)) {
            api.limpar();
            api.cabecalho('Reunião', null);
            const p = api.p;
            api.corpo.appendChild(
              api.el(
                'div',
                `font:600 14px/1.45 system-ui,sans-serif;margin-bottom:8px;color:${p.texto}`,
                'A extensão foi recarregada — atualize esta página.'
              )
            );
            api.corpo.appendChild(
              api.el(
                'div',
                `font:400 12px/1.5 system-ui,sans-serif;color:${p.textoFraco}`,
                'Esta aba ainda está com a versão antiga carregada, e ela não fala ' +
                  'mais com a extensão. Um F5 resolve.'
              )
            );
            api.acao('Atualizar a página', () => window.location.reload());
            return;
          }
          resposta = { erro: texto };
        }

        // Painel AINDA NÃO CONFIGURADO (sem PAINEL_API_URL/tokens): seguimos
        // com as capacidades padrão, marcadas como prévia. É o que permite
        // conferir a tela inteira antes de os tokens existirem — e o aviso
        // deixa claro que a distribuição real ainda não está valendo.
        if (resposta && resposta.configurado === false) {
          estado.eu = {
            email: atendente.email,
            nome: atendente.nome || atendente.email.split('@')[0],
            userId: atendente.userId || null,
            papel: null,
            capacidades: Object.keys(TIPOS).map((t) => ({
              type: t,
              allowed: true,
              assignment: t === 'apresentacao' ? 'self' : 'round_robin',
              can_choose_assignee: t === 'apresentacao',
            })),
          };
          estado.previa = true;
          passoModo();
          return;
        }

        // Painel configurado MAS o e-mail não é usuário ativo lá: aí é erro de
        // verdade, e insistir só levaria a 403 no fim do formulário.
        if (!resposta || resposta.erro || !resposta.identificado) {
          api.limpar();
          const p = api.p;
          api.corpo.appendChild(
            api.el(
              'div',
              `font:500 14px/1.5 system-ui,sans-serif;margin-bottom:10px`,
              `O painel não reconheceu ${atendente.email} como usuário ativo.`
            )
          );
          api.corpo.appendChild(
            api.el(
              'div',
              `font:400 12px/1.5 system-ui,sans-serif;color:${p.textoFraco}`,
              resposta && resposta.erro
                ? String(resposta.erro)
                : 'Confira com quem cuida do painel se esse e-mail está ativo lá.'
            )
          );
          return;
        }

        estado.eu = resposta.eu;
        // O painel confirma quem é; o id de usuário do chatPro só existe aqui.
        estado.eu.userId = atendente.userId || null;
        passoModo();
      }

      // ── Passo 1: agora ou marcar ─────────────────────────────────────────
      function passoModo() {
        api.limpar();
        api.cabecalho('Reunião', null);
        const p = api.p;

        // A faixa de prévia é permanente enquanto faltar configuração: sem ela
        // dá pra marcar achando que a distribuição real já está valendo.
        if (estado.previa) {
          api.aviso(
            estado.semAtendente
              ? 'Prévia — não identifiquei seu e-mail no chatPro, então nada será atribuído.'
              : 'Prévia — o painel de reuniões ainda não está configurado no servidor.'
          );
        }

        // Cabeçalho de seção igual ao "Chats anteriores" do Copiloto.
        const quem = estado.eu && estado.eu.nome
          ? `Marcando como ${estado.eu.nome}${estado.eu.papel ? ` · ${estado.eu.papel}` : ''}`
          : 'Marcar reunião';
        const lista = api.secao(quem);

        api.cartao(lista, 'Reunir agora', 'Cria a sala e manda o link pro cliente na hora.', () => {
          estado.modo = 'agora';
          passoTipo();
        });
        api.cartao(
          lista,
          'Marcar para depois',
          'Escolhe dia e horário livres. O convite sai 5 min antes.',
          () => {
            estado.modo = 'marcar';
            passoTipo();
          }
        );
      }

      // ── Passo 2: tipo, só o que este atendente pode ──────────────────────
      function passoTipo() {
        api.limpar();
        api.cabecalho('Tipo da reunião', passoModo);
        const p = api.p;

        const permitidos = (estado.eu.capacidades || []).filter((c) => c.allowed);
        if (permitidos.length === 0) {
          api.aviso(
            'O painel não liberou nenhum tipo de reunião para o seu usuário. ' +
              'Fale com a supervisão.',
            'erro'
          );
          return;
        }

        const lista = api.secao('Tipo da reunião');
        for (const cap of permitidos) {
          const meta = TIPOS[cap.type];
          if (!meta) continue;
          // O modo de atribuição muda o que vai acontecer — dizer antes evita
          // a surpresa de marcar e a reunião cair pra outra pessoa.
          const explica =
            cap.assignment === 'self'
              ? 'fica com você'
              : cap.assignment === 'round_robin'
                ? 'entra na distribuição'
                : 'você escolhe o responsável';
          api.cartao(lista, meta.rotulo, explica, () => {
            estado.tipo = cap.type;
            estado.capacidade = cap;
            passoDados();
          });
        }
      }

      // ── Passo 3: dados do cliente ────────────────────────────────────────
      function passoDados() {
        api.limpar();
        api.cabecalho(TIPOS[estado.tipo].rotulo, passoTipo);
        const p = api.p;
        const precisaCadastro = COM_DADOS.includes(estado.tipo);

        const nome = api.campo('Nome do cliente *', { placeholder: 'Quem vai participar' });
        const empresa = api.campo('Nome da empresa *', { placeholder: 'Razão social' });
        const telefone = api.campo('Telefone *', { placeholder: '(11) 90000-0000' });
        api.corpo.append(nome.wrap, empresa.wrap, telefone.wrap);

        /**
         * O que a pessoa JÁ preencheu numa passagem anterior por aqui.
         *
         * Voltar pra este passo é caminho normal, não exceção: o ‹ do topo da
         * grade de horários e o "Tentar de novo" da tela de recusa terminam os
         * dois nesta função. Sem restaurar daqui, um 422 de campo faltando
         * apagava CNPJ, instância, e-mail, provedor e motivo — a pessoa levava
         * o erro DEPOIS de preencher tudo e tinha que digitar tudo de novo, que
         * é exatamente o retrabalho que o resto deste passo tenta evitar.
         */
        const jaTinha = estado.cliente || null;

        // O que já dá pra saber da conversa entra preenchido — o atendente
        // confere em vez de digitar. O que ele mesmo escreveu vale mais que a
        // conversa, então vem primeiro.
        if (jaTinha && jaTinha.nome) nome.entrada.value = jaTinha.nome;
        else if (contexto.contato) nome.entrada.value = contexto.contato;
        if (jaTinha && jaTinha.empresa) empresa.entrada.value = jaTinha.empresa;
        if (jaTinha && jaTinha.telefone) telefone.entrada.value = jaTinha.telefone;
        else if (contexto.telefone) telefone.entrada.value = comoTexto(contexto.telefone);

        // Digitar, colar, arrastar, autocompletar: tudo passa pelo mesmo
        // formatador, e o valor que veio da conversa já entra formatado.
        instalarFormatacao(telefone, formatarTelefone);

        let cnpj = null;
        let instancia = null;
        let emailCliente = null;
        let semEmail = null;
        let provedor = null;
        let clientType = null;
        let motivoCs = null;
        let vendedorConta = null;
        let planoOficial = null;

        if (precisaCadastro) {
          cnpj = api.campo('CNPJ *', { placeholder: '00.000.000/0000-00' });
          instancia = api.campo('Código da instância *', {
            placeholder: 'chatpro-xxxxxxxxxx',
          });

          // E-mail do cliente. A API aceita como OPCIONAL, mas a tela do painel
          // marca como obrigatório em migração e CS — e é por ele que sai o
          // convite com .ics. Seguimos o painel: exigir aqui é mais seguro que
          // deixar passar e o cliente não receber nada.
          //
          // Quem realmente não tem e-mail marca "Não enviar" e segue.
          emailCliente = api.campo('E-mail do cliente *', {
            tipo: 'email',
            placeholder: 'cliente@empresa.com',
          });
          api.corpo.appendChild(emailCliente.wrap);

          semEmail = api.caixa(
            'Não enviar e-mail',
            'O cliente recebe o link pelo WhatsApp de qualquer forma.'
          );
          api.corpo.appendChild(semEmail.wrap);
          // Marcar "não enviar" apaga a exigência do e-mail na hora — senão a
          // pessoa fica presa num campo que ela acabou de dizer que não usa.
          semEmail.entrada.addEventListener('change', () => {
            const dispensado = semEmail.entrada.checked;
            emailCliente.wrap.style.opacity = dispensado ? '.5' : '1';
            emailCliente.entrada.disabled = dispensado;
            if (dispensado) emailCliente.erro.style.display = 'none';
          });
          api.corpo.append(cnpj.wrap, instancia.wrap);

          // Os cadastrais de uma passagem anterior. O CNPJ entra ANTES de
          // `instalarFormatacao` logo abaixo: é ela que formata o valor que já
          // está no campo (numa microtarefa) e que dispara a consulta da razão
          // social — restaurar depois deixaria o número cru na tela.
          if (jaTinha) {
            if (jaTinha.cnpj) cnpj.entrada.value = jaTinha.cnpj;
            if (jaTinha.instancia) instancia.entrada.value = jaTinha.instancia;
            if (jaTinha.email) emailCliente.entrada.value = jaTinha.email;
            if (jaTinha.semEmail) {
              semEmail.entrada.checked = true;
              // Marcar por código NÃO dispara `change` — sem este empurrão o
              // campo de e-mail voltaria exigido e habilitado, contradizendo a
              // caixa que a própria pessoa marcou.
              semEmail.entrada.dispatchEvent(new Event('change'));
            }
          }

          // ── O CNPJ preenchendo a Empresa ───────────────────────────────
          //
          // Uma linha pequena embaixo do campo Empresa conta as três coisas que
          // a pessoa precisa saber, uma de cada vez: que estamos buscando, de
          // onde veio o nome que apareceu, ou que não achamos. É ela que faz o
          // preenchimento automático ser PERCEBIDO — sem isso, um nome brota no
          // campo e a pessoa não sabe se digitou, se colou ou de onde saiu.
          //
          // Estilo em token (`--gray-50` pelo `p.textoFraco`): cor literal aqui
          // inverte no tema claro e a linha some no fundo.
          const dicaEmpresa = api.el(
            'span',
            `display:none;font-size:.6875rem;line-height:1.35;color:${p.textoFraco}`
          );
          // Aparece e some por `display`, como o `.cpm-erro` — o atributo
          // `hidden` perde pra qualquer regra que o chatPro tenha em
          // `.input span`, e a linha ficaria ocupando espaço vazia.
          //
          // Antes do `.cpm-erro` pra que a mensagem de validação continue sendo
          // a última linha do campo quando as duas aparecerem juntas.
          empresa.wrap.insertBefore(dicaEmpresa, empresa.erro);

          /**
           * O texto que NÓS escrevemos em Empresa e o CNPJ que o produziu.
           *
           * Enquanto o campo tiver exatamente esse texto, ele ainda é nosso e
           * pode ser trocado. Na primeira tecla da pessoa o valor passa a ser
           * dela e não encostamos mais: o nome que ela escreveu pode ser o que
           * o cliente pediu pra aparecer no convite.
           */
          let empresaAutomatica = null;
          let cnpjDaOrigem = null;
          /** De qual CNPJ a linha embaixo de Empresa está falando. */
          let dicaDoCnpj = null;

          function mostrarDica(texto, digitos) {
            dicaEmpresa.textContent = texto;
            dicaEmpresa.style.display = 'block';
            dicaDoCnpj = digitos;
          }

          function esconderDica() {
            dicaEmpresa.textContent = '';
            dicaEmpresa.style.display = 'none';
            dicaDoCnpj = null;
          }

          /** Dá pra escrever em Empresa sem passar por cima de ninguém? */
          function empresaLivre() {
            const v = empresa.entrada.value;
            return v.trim() === '' || v === empresaAutomatica;
          }

          /**
           * Mudou o CNPJ: o que veio do anterior não vale mais. Sai o nome, SE
           * ele ainda for o que nós preenchemos — o que a pessoa digitou fica
           * onde está, sempre.
           */
          function soltarPreenchimento() {
            if (cnpjDaOrigem === null) return;
            if (empresa.entrada.value === empresaAutomatica) empresa.entrada.value = '';
            empresaAutomatica = null;
            cnpjDaOrigem = null;
          }

          // Digitou em Empresa: daqui pra frente o campo é dela, e o rótulo de
          // origem viraria mentira ao lado de um nome escrito à mão.
          empresa.entrada.addEventListener('input', () => {
            if (empresa.entrada.value === empresaAutomatica) return;
            empresaAutomatica = null;
            cnpjDaOrigem = null;
            esconderDica();
          });

          instalarFormatacao(cnpj, formatarCnpj, (valor) => {
            const digitos = soDigitos(valor);
            // O rótulo e o nome preenchido pertencem ao CNPJ que os trouxe.
            // Trocou o CNPJ, os dois vão junto — antes de qualquer consulta.
            if (digitos !== dicaDoCnpj) esconderDica();
            if (digitos !== cnpjDaOrigem) soltarPreenchimento();

            const completo = digitos.length === 14;
            if (completo && !cnpjValido(valor)) {
              cnpj.erro.textContent = 'CNPJ inválido — confira os dígitos.';
              cnpj.erro.style.display = 'block';
              cancelarConsulta();
              avisarChecklist(false);
              return;
            }
            cnpj.erro.style.display = 'none';
            if (!completo) {
              cancelarConsulta();
              avisarChecklist(false);
              return;
            }
            agendarConsulta(valor);
          });

          // Migração distingue cliente da base de prospect: são pools
          // diferentes de condutores, e o errado devolve a grade da outra fila.
          if (estado.tipo === 'migracao') {
            clientType = api.campo('Tipo de cliente', { select: true });
            opcoesDo(clientType, [
              ['base', 'Já é cliente (base)'],
              ['prospect', 'Ainda não é cliente (prospect)'],
            ]);
            // As opções são fixas e já estão no DOM, então a escolha anterior
            // volta aqui mesmo (os seletores de vendedor, que chegam da rede,
            // são restaurados dentro de `carregarVendedores`).
            if (jaTinha && jaTinha.clientType) clientType.entrada.value = jaTinha.clientType;
            api.corpo.appendChild(clientType.wrap);
          }

          // Implantação e CS não sobem sem provedor — o painel devolve 422.
          if (estado.tipo === 'implantacao' || estado.tipo === 'cs') {
            provedor = api.campo('Provedor', { select: true });
            // Sem opção em branco, o <select> abre já marcado em "Starter" e
            // quem não encostar no campo sobe a reunião classificada errado —
            // o painel aceita sem reclamar. Mesmo tratamento do motivo do CS.
            opcoesDo(provedor, PROVEDORES, 'Selecione o provedor');
            if (jaTinha && jaTinha.provedor) provedor.entrada.value = jaTinha.provedor;
            api.corpo.appendChild(provedor.wrap);
          }

          // CS exige o motivo (`cs_reason`). Começa em branco de propósito:
          // "treinamento de IA" e "retenção" são atendimentos diferentes, e
          // deixar a primeira opção pré-marcada classificaria a reunião sozinho.
          if (estado.tipo === 'cs') {
            motivoCs = api.campo('Motivo do atendimento', { select: true });
            opcoesDo(motivoCs, MOTIVOS_CS, 'Selecione o motivo');
            if (jaTinha && jaTinha.csReason) motivoCs.entrada.value = jaTinha.csReason;
            api.corpo.appendChild(motivoCs.wrap);
          }

          // Migração exige `vendedor_email`. Não é quem vai conduzir a reunião:
          // é o vendedor DONO da conta, que o painel usa pra atribuição
          // comercial. Sem ele a API devolve 422.
          if (estado.tipo === 'migracao') {
            vendedorConta = api.campo('Especialista em vendas responsável *', { select: true });
            opcoesDo(vendedorConta, [], 'Selecione o especialista em vendas');
            carregarVendedores(vendedorConta, estado.vendedorEmail);
            api.corpo.appendChild(vendedorConta.wrap);

            // Plano Oficial: OPCIONAL na API (o 422 não reclama da ausência) e
            // opcional na tela do painel também. Fica sem exigência aqui.
            planoOficial = api.campo('Plano Oficial contratado', { select: true });
            opcoesDo(planoOficial, PLANOS_OFICIAL, 'Selecione o plano');
            if (jaTinha && jaTinha.oficialPlan) {
              planoOficial.entrada.value = jaTinha.oficialPlan;
            }
            api.corpo.appendChild(planoOficial.wrap);
          }

          // ── A consulta do CNPJ ─────────────────────────────────────────
          //
          // O campo avisa a cada tecla, a cada colagem e ao sair do foco. A
          // espera de meio segundo é o que separa "uma consulta pelo CNPJ" de
          // "uma consulta por dígito" — e, sem ela, a resposta do CNPJ pela
          // metade ainda voltaria depois da resposta do CNPJ inteiro.
          const ESPERA_MS = 500;

          /** Consulta em voo: a mais nova manda, as atrasadas são descartadas. */
          let consultaAtual = 0;
          /** A última resposta e o CNPJ que a produziu — ver `consultarCnpj`. */
          let respostaEmMaos = null;
          let timerConsulta = null;

          function agendarConsulta(valor) {
            if (timerConsulta) clearTimeout(timerConsulta);
            timerConsulta = setTimeout(() => {
              timerConsulta = null;
              void consultarCnpj(valor);
            }, ESPERA_MS);
          }

          function cancelarConsulta() {
            if (timerConsulta) clearTimeout(timerConsulta);
            timerConsulta = null;
            // Quem já estiver voltando fala de um CNPJ que não está mais lá.
            consultaAtual += 1;
          }

          let avisoChecklist = null;
          /**
           * Migração sem checklist ativo: o painel RECUSA o POST no fim, e a
           * pessoa perde o formulário inteiro. A frase é a MESMA que ele
           * devolve no 422 — quem já levou esse erro reconhece na hora, e quem
           * for procurar no painel acha pelo mesmo texto.
           *
           * Fica colado no campo CNPJ, não no topo da aba: o problema é DESTE
           * CNPJ, e é pra ele que a pessoa está olhando.
           */
          function avisarChecklist(faltando) {
            if (!faltando) {
              if (avisoChecklist) avisoChecklist.remove();
              avisoChecklist = null;
              return;
            }
            if (avisoChecklist) return;
            // `.cpm-nota` é o bloco que a aba já tem (padding, raio e fundo em
            // token). Só a cor entra aqui, e entra pela variável — igual ao
            // `api.aviso`, nunca em rgb/hex.
            const nota = document.createElement('div');
            nota.className = 'cpm-nota';
            nota.textContent = SEM_CHECKLIST;

            // O link do onboarding é gerado DURANTE a migração, não antes —
            // mandar a pessoa sair da tela pra criar em outro lugar quebra o
            // atendimento por uma regra de ordem que não é dela. Então o botão
            // resolve aqui. É escrita, por isso é um clique explícito.
            const gerar = api.botao('Gerar o link do onboarding');
            gerar.style.marginTop = '.5rem';
            gerar.addEventListener('click', async () => {
              const vendedor = vendedorConta && vendedorConta.entrada.value;
              const instanciaValor = instancia.entrada.value.trim();
              if (!vendedor || instanciaValor === '') {
                nota.textContent =
                  'Pra gerar o link, informe antes o vendedor da conta e o código da instância.';
                return;
              }
              gerar.disabled = true;
              gerar.textContent = 'Gerando…';
              const r = await pedir('PAINEL_GERAR_MIGRACAO', {
                cnpj: cnpj.entrada.value,
                vendedorEmail: vendedor,
                instanceCode: instanciaValor,
              }).catch(() => null);

              if (r && r.ok) {
                // Some o aviso inteiro: o impedimento acabou.
                avisarChecklist(false);
                const feito = document.createElement('div');
                feito.className = 'cpm-nota';
                feito.textContent = 'Link do onboarding gerado — dá pra agendar a migração.';
                cnpj.wrap.appendChild(feito);
                avisoChecklist = feito;
                return;
              }
              gerar.disabled = false;
              gerar.textContent = 'Gerar o link do onboarding';
              nota.textContent =
                (r && (r.detail || r.error)) || 'Não deu pra gerar o link agora. Tente de novo.';
            });

            nota.appendChild(gerar);
            cnpj.wrap.appendChild(nota);
            avisoChecklist = nota;
          }

          function rotuloDaFonte(fonte) {
            if (fonte === 'brasilapi') return 'Razão social da Receita, preenchida sozinha.';
            if (fonte === 'painel') return 'Razão social do painel, preenchida sozinha.';
            // Fonte que a rota não nomeou: continua valendo dizer que não foi a
            // pessoa que digitou — é isso que ela precisa saber.
            return 'Razão social preenchida sozinha pelo CNPJ.';
          }

          /**
           * O que fazer com a resposta do painel. Separado da consulta porque
           * roda também quando o mesmo CNPJ volta (apagou um dígito, digitou de
           * novo): aí a resposta vem da memória, sem rede.
           */
          function aplicarResposta(resposta, podePreencher) {
            avisarChecklist(estado.tipo === 'migracao' && resposta.temChecklist === false);
            if (!podePreencher) {
              // A pessoa digitou a empresa enquanto a resposta vinha. O nome
              // dela vale mais que o cadastro — some só o "buscando".
              if (dicaDoCnpj === resposta.digitos) esconderDica();
              return;
            }
            if (!resposta.achado) {
              // Não é erro e não pinta de vermelho: a razão social é
              // conveniência, não etapa do fluxo. A linha só conta o que
              // aconteceu e devolve o campo pra pessoa.
              mostrarDica(
                'Não achamos a razão social deste CNPJ — escreva a empresa na mão.',
                resposta.digitos
              );
              return;
            }
            empresa.entrada.value = resposta.achado;
            empresaAutomatica = resposta.achado;
            cnpjDaOrigem = resposta.digitos;
            // O campo acabou de ser preenchido: "Informe a empresa." de uma
            // tentativa anterior de envio não faz mais sentido.
            empresa.erro.style.display = 'none';
            mostrarDica(rotuloDaFonte(resposta.fonte), resposta.digitos);
          }

          /**
           * CNPJ completo e válido: pergunta a razão social e, na migração,
           * se existe checklist.
           *
           * Nada aqui é erro na tela. A rota pode não existir neste servidor
           * (404 chega como "não achei", o service worker traduz), o CNPJ pode
           * não estar em fonte nenhuma e o painel pode estar fora do ar — os
           * três terminam no mesmo lugar: campo livre pra digitar na mão.
           */
          async function consultarCnpj(valor) {
            const digitos = soDigitos(valor);
            const querRazao = empresaLivre();
            const querChecklist = estado.tipo === 'migracao';
            // Empresa já é da pessoa e o tipo não depende de checklist: não há
            // o que fazer com a resposta, então não há por que perguntar.
            if (!querRazao && !querChecklist) return;

            if (respostaEmMaos && respostaEmMaos.digitos === digitos) {
              aplicarResposta(respostaEmMaos, querRazao);
              return;
            }

            const minha = (consultaAtual += 1);
            // Indicador ao LADO do campo, nunca no lugar do valor: a pessoa
            // continua digitando Empresa enquanto a resposta não chega.
            if (querRazao) mostrarDica('Buscando a razão social…', digitos);

            const r = await pedir('PAINEL_CNPJ', { cnpj: digitos }).catch(() => null);
            // `temChecklist` vem junto com a razão social quando alguma fonte
            // respondeu. Quando nenhuma respondeu, quem sabe do checklist é a
            // rota do onboarding — e na migração vale o pedido a mais.
            const veioNaResposta = r && r.dados && typeof r.dados.temChecklist === 'boolean';
            let temChecklist = veioNaResposta ? r.dados.temChecklist : null;
            if (querChecklist && temChecklist === null) {
              const s = await pedir('PAINEL_MIGRACAO_STATUS', { cnpj: digitos }).catch(() => null);
              // `false` cobre "o painel disse que não tem" e "não deu pra
              // confirmar": prometer uma migração que o POST vai recusar é pior
              // que um aviso a mais na tela.
              if (s && typeof s.temChecklist === 'boolean') temChecklist = s.temChecklist;
            }

            // Chegou tarde: já saiu outra consulta, ou o campo já é outro CNPJ.
            if (minha !== consultaAtual) return;
            if (soDigitos(cnpj.entrada.value) !== digitos) return;

            respostaEmMaos = {
              digitos,
              achado: r && r.encontrado === false ? null : razaoSocialDe(r),
              fonte: (r && r.dados && r.dados.fonte) || null,
              temChecklist,
            };
            // Reconferir agora, não lá atrás: entre perguntar e responder a
            // pessoa pode ter digitado a empresa.
            aplicarResposta(respostaEmMaos, empresaLivre());
          }
        }

        /**
         * A lista de vendedores do painel, pros dois seletores que a usam.
         *
         * `escolhidoAntes` é restaurado DEPOIS das opções chegarem: a opção só
         * existe quando a resposta volta, e marcar antes disso não pegaria —
         * o seletor voltaria em branco toda vez que a pessoa reabrisse o passo.
         */
        function carregarVendedores(campo, escolhidoAntes) {
          pedir('PAINEL_VENDEDORES')
            .then((r) => {
              for (const v of (r && r.vendedores) || []) {
                const o = document.createElement('option');
                o.value = v.email;
                o.textContent = v.nome;
                campo.entrada.appendChild(o);
              }
              // E-mail que não veio na lista simplesmente não marca nada — o
              // `<select>` fica na opção em branco, que é o estado honesto.
              if (escolhidoAntes) campo.entrada.value = escolhidoAntes;
            })
            .catch(() => {});
        }

        // Seletor de quem CONDUZ (`assignee_email`): só quando o painel disse
        // que esta pessoa escolhe. Mandar o campo sem permissão volta 403 ("Só
        // supervisor pode escolher o responsável") — e volta com o formulário
        // inteiro preenchido, que é o que estamos tentando evitar.
        let responsavel = null;
        if (estado.capacidade && estado.capacidade.can_choose_assignee) {
          responsavel = api.campo('Quem vai conduzir', { select: true });
          opcoesDo(responsavel, [], 'Distribuir automaticamente');
          carregarVendedores(responsavel, estado.assigneeEmail);
          api.corpo.appendChild(responsavel.wrap);
        }

        // A reunião pode não ficar com quem está marcando. Isso está combinado
        // — o que não pode é a pessoa descobrir só na tela de sucesso, então a
        // frase aparece ANTES do botão de confirmar.
        if (estado.capacidade && estado.capacidade.assignment === 'round_robin') {
          const nota = document.createElement('div');
          nota.className = 'cpm-nota';
          nota.textContent = responsavel
            ? 'Sem escolher quem conduz, a reunião entra na distribuição automática do painel.'
            : 'Esta reunião entra na distribuição automática do painel — quem vai conduzir é definido lá.';
          api.corpo.appendChild(nota);
        }

        api.acao(estado.modo === 'agora' ? 'Criar e enviar' : 'Escolher horário', () => {
          let ok = true;
          const exigir = (c, texto) => {
            if (c.entrada.value.trim() === '') {
              c.erro.textContent = texto;
              c.erro.style.display = 'block';
              ok = false;
            } else {
              c.erro.style.display = 'none';
            }
          };
          exigir(nome, 'Informe o nome do contato.');
          exigir(empresa, 'Informe a empresa.');
          exigir(telefone, 'Informe o telefone.');
          if (precisaCadastro) {
            exigir(cnpj, 'Informe o CNPJ.');
            exigir(instancia, 'Informe o código da instância.');
            if (cnpj.entrada.value && !cnpjValido(cnpj.entrada.value)) {
              cnpj.erro.textContent = 'CNPJ inválido — confira os dígitos.';
              cnpj.erro.style.display = 'block';
              ok = false;
            }
            // Os campos que a API exige e o formulário não pedia.
            if (motivoCs) exigir(motivoCs, 'Escolha o motivo do atendimento.');
            if (vendedorConta) exigir(vendedorConta, 'Escolha o vendedor da conta.');
            if (provedor) exigir(provedor, 'Escolha o provedor da conta.');

            // E-mail: exigido como na tela do painel, a não ser que a pessoa
            // tenha marcado "não enviar".
            if (emailCliente && semEmail && !semEmail.entrada.checked) {
              exigir(emailCliente, 'Informe o e-mail do cliente.');
              const valor = emailCliente.entrada.value.trim();
              if (valor !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(valor)) {
                emailCliente.erro.textContent = 'E-mail inválido.';
                emailCliente.erro.style.display = 'block';
                ok = false;
              }
            }
          }
          if (!ok) return;

          estado.cliente = {
            nome: nome.entrada.value.trim(),
            empresa: empresa.entrada.value.trim(),
            telefone: telefone.entrada.value.trim(),
          };
          if (precisaCadastro) {
            estado.cliente.cnpj = cnpj.entrada.value.trim();
            estado.cliente.instancia = instancia.entrada.value.trim();
            if (provedor) estado.cliente.provedor = provedor.entrada.value;
            if (clientType) estado.cliente.clientType = clientType.entrada.value;
            if (motivoCs) estado.cliente.csReason = motivoCs.entrada.value;
            if (planoOficial && planoOficial.entrada.value) {
              estado.cliente.oficialPlan = planoOficial.entrada.value;
            }
            if (emailCliente && !semEmail.entrada.checked) {
              estado.cliente.email = emailCliente.entrada.value.trim();
            }
            if (semEmail && semEmail.entrada.checked) estado.cliente.semEmail = true;
          }
          // Os dois papéis são diferentes e vão em campos diferentes da API:
          // `vendedor_email` é o dono da conta (migração exige), `assignee_email`
          // é quem conduz — e este último SÓ pode sair de quem tem permissão.
          estado.vendedorEmail = vendedorConta ? vendedorConta.entrada.value || null : null;
          estado.assigneeEmail = responsavel ? responsavel.entrada.value || null : null;

          if (estado.modo === 'agora') confirmar(null);
          else passoHorario();
        });
      }

      // ── Passo 4: dia e horário, da grade real ────────────────────────────
      //
      // A tira de dias é o que o painel de reuniões mostra e a aba não mostrava.
      // Aqui havia só um `<input type="date">`: pra descobrir ONDE existia vaga
      // a pessoa clicava dia a dia, e sábado, feriado e agenda cheia só
      // apareciam depois do clique — "Sem horário livre em sábado, 15/08. Tente
      // outro dia." era a tela mandando ela adivinhar.
      //
      // Agora os próximos dias úteis chegam de uma vez, cada cartão com quantas
      // vagas o dia tem. A contagem é `disponiveis.length` — vaga POR DIA. A
      // API não devolve quantas sobram em CADA horário, e número inventado numa
      // tela de agendamento é pior que número nenhum.
      function passoHorario() {
        estiloDoSeletorDeDia();
        api.limpar();
        api.cabecalho('Quando', passoDados);

        const DIAS_POR_PAGINA = 7;
        /** Grade de demonstração da prévia — o painel real não responde nela. */
        const HORARIOS_PREVIA = [
          '09:00',
          '09:30',
          '10:00',
          '11:00',
          '14:00',
          '14:30',
          '15:00',
          '16:30',
        ];
        const BLOQUEADOS_PREVIA = ['10:30', '13:30'];

        // Cache por (tipo, dia, clientType), vivo enquanto a aba estiver aberta:
        // trocar de dia e voltar não pode refazer as chamadas. Mora no `estado`,
        // e não numa variável daqui, porque `passoHorario` roda de novo a cada
        // volta — o 409 de horário ocupado traz a pessoa direto pra cá.
        const memoria =
          estado.memoriaGrade || (estado.memoriaGrade = { dias: new Map(), maxDate: null });

        // O MESMO client_type que o POST vai usar — não o que está no
        // formulário. O servidor força 'prospect' em apresentação e 'base' nos
        // demais quando o campo não existe na tela; consultar a grade com um
        // valor e marcar com outro deixaria a pessoa escolher um horário
        // mostrado como livre e levar 409 no fim. Hoje as duas grades vêm
        // iguais (medido), mas base e prospect são pools distintos por contrato
        // e podem divergir a qualquer configuração.
        const clientType =
          (estado.cliente && estado.cliente.clientType) ||
          (estado.tipo === 'apresentacao' ? 'prospect' : 'base');
        const chaveDe = (data) => `${estado.tipo}|${data}|${clientType}`;

        // Chegar aqui com um horário JÁ escolhido significa que a tentativa
        // anterior não passou — quase sempre o 409 de alguém ter ocupado o
        // horário entre consultar e confirmar. A fotografia daquele dia está
        // velha: joga fora, senão a tira ofereceria de novo o horário recusado.
        if (estado.data && estado.hora) memoria.dias.delete(chaveDe(estado.data));

        function elc(tag, classe, texto) {
          const n = document.createElement(tag);
          if (classe) n.className = classe;
          if (texto !== undefined) n.textContent = texto;
          return n;
        }

        /**
         * A grade de UM dia, sempre como promessa e sempre passando pelo cache.
         */
        function buscarDia(data) {
          const chave = chaveDe(data);
          const guardada = memoria.dias.get(chave);
          if (guardada) return guardada;

          // Prévia: o painel não tem como responder grade nenhuma (sem token, ou
          // sem e-mail pra mandar como `actor_email`). Fazer 7 chamadas pra
          // receber 7 erros deixaria a tira inteira com "—" justo pra quem só
          // quer conferir o desenho — então a demonstração é montada aqui.
          if (estado.previa) {
            const util = ehDiaUtil(data);
            const demo = Promise.resolve({
              disponiveis: util ? HORARIOS_PREVIA.slice() : [],
              bloqueados: util ? BLOQUEADOS_PREVIA.slice() : [],
              ok: true,
            });
            memoria.dias.set(chave, demo);
            return demo;
          }

          // A promessa entra no cache ANTES de resolver: se a tira e o seletor
          // de data pedirem o mesmo dia ao mesmo tempo, sai uma chamada só.
          const promessa = pedir('PAINEL_HORARIOS', {
            tipoReuniao: estado.tipo,
            data,
            email: estado.eu.email,
            clientType: clientType || null,
          })
            .catch(() => null)
            .then((r) => {
              const g = (r && r.grade) || null;
              const grade = {
                disponiveis: (g && g.disponiveis) || [],
                bloqueados: (g && g.bloqueados) || [],
                ok: Boolean(r && r.disponivel !== false && g),
              };
              // `max_date`: o POST recusa data além dele. Guardar aqui é o que
              // impede a tira de oferecer dia que o servidor vai rejeitar.
              if (g && g.maxDate) memoria.maxDate = g.maxDate;
              // Falha NÃO fica no cache: painel fora do ar é passageiro, e um
              // "—" grudado até fechar a aba esconderia horário que existe.
              if (!grade.ok) memoria.dias.delete(chave);
              return grade;
            });
          memoria.dias.set(chave, promessa);
          return promessa;
        }

        // ── A tela ──────────────────────────────────────────────────────────

        /** Dias na tira, em ordem, e o cartão de cada um. */
        const dias = [];
        const cartoes = new Map();
        let diaEscolhido = null;
        /** Onde a próxima página começa a procurar. */
        let cursor = hojeLocal(0);
        let esgotou = false;
        let carregando = false;
        /** Sobe a cada remontagem da tira: resposta de tira velha é descartada. */
        let geracao = 0;

        api.corpo.appendChild(elc('div', 'cpm-rotulo', 'Data'));

        const tira = elc('div', 'cpm-dias');
        tira.setAttribute('role', 'group');
        tira.setAttribute('aria-label', 'Dias com horário livre');
        api.corpo.appendChild(tira);

        const acoes = elc('div', 'cpm-dias-acoes');
        const btnMais = api.botao('Ver mais dias');
        const btnOutra = api.botao('Outra data');
        const btnTentar = api.botao('Tentar de novo');
        btnOutra.setAttribute('aria-expanded', 'false');
        btnTentar.style.display = 'none';
        acoes.append(btnMais, btnOutra, btnTentar);
        api.corpo.appendChild(acoes);

        // O `<input type="date">` continua aqui, escondido: é o caminho pro dia
        // distante (o mês que vem), que nenhuma tira alcança clicando "ver mais
        // dias" — e é ele que abre o calendário do navegador.
        const seletorData = api.campo('Ir para o dia', { tipo: 'date' });
        seletorData.entrada.min = hojeLocal(0);
        if (memoria.maxDate) seletorData.entrada.max = memoria.maxDate;
        seletorData.wrap.style.display = 'none';
        api.corpo.appendChild(seletorData.wrap);

        const recado = elc('div', 'cpm-recado', '');
        recado.style.display = 'none';
        api.corpo.appendChild(recado);

        const blocoHora = elc('div', 'cpm-secao');
        blocoHora.style.display = 'none';
        blocoHora.appendChild(elc('div', 'cpm-rotulo', 'Horário disponível'));
        const lista = elc('div', '');
        blocoHora.appendChild(lista);
        api.corpo.appendChild(blocoHora);

        function dizer(texto) {
          recado.textContent = texto || '';
          recado.style.display = texto ? '' : 'none';
        }

        function atualizarAcoes() {
          btnMais.style.display = esgotou ? 'none' : '';
        }

        /**
         * A frase abaixo da tira, lida da PRÓPRIA tira — não da última resposta.
         * É o que mantém o recado certo quando um dia "?" é reconsultado no
         * clique e passa a ter vaga.
         */
        function revisarRecado() {
          const cs = dias.map((d) => cartoes.get(d));
          const falharam = cs.filter((c) => c.falhou).length;
          const totalVagas = cs.reduce((s, c) => s + c.total, 0);

          // Tira vazia só acontece quando o `max_date` cortou tudo.
          if (cs.length === 0) {
            dizer(
              memoria.maxDate ? `A agenda do painel vai até ${diaLegivel(memoria.maxDate)}.` : ''
            );
            return;
          }
          if (falharam === cs.length) {
            dizer('Não consegui falar com o painel agora.');
            btnTentar.style.display = '';
            return;
          }
          btnTentar.style.display = 'none';

          const partes = [];
          if (totalVagas === 0) {
            // Nenhuma vaga em dia nenhum da tira: dizer isso e deixar "Ver mais
            // dias" à mão é o contrário do que a tela antiga fazia, que era
            // mandar a pessoa testar um dia por vez até achar.
            partes.push(
              esgotou && memoria.maxDate
                ? `Nenhum horário livre até ${diaLegivel(memoria.maxDate)} — a agenda do painel vai só até lá.`
                : `Nenhum horário livre nestes ${cs.length} dias. Veja mais dias ou escolha outra data.`
            );
          }
          // Falha em ALGUNS dias não pode passar em silêncio: o "?" na tira
          // precisa de uma frase que diga o que ele é.
          if (falharam > 0) {
            partes.push(
              falharam === 1
                ? 'Um dia não respondeu (?) — clique nele pra consultar de novo.'
                : `${falharam} dias não responderam (?) — clique neles pra consultar de novo.`
            );
          }
          dizer(partes.join(' '));
        }

        function rolarAte(data) {
          const c = cartoes.get(data);
          if (c) c.botao.scrollIntoView({ block: 'nearest', inline: 'center' });
        }

        /**
         * O cartão nasce desabilitado e com o esqueleto no lugar da contagem: o
         * dia da semana e o número já são nossos, quantas vagas tem só a API
         * sabe — e são 7 chamadas até saber.
         */
        function cartaoDia(data) {
          const b = elc('button', 'cpm-dia');
          b.type = 'button';
          b.disabled = true;
          b.setAttribute('aria-pressed', 'false');
          const partes = partesDoDia(data);
          b.append(
            elc('span', 'cpm-dia-semana', partes.semana),
            elc('span', 'cpm-dia-num', partes.numero),
            elc('span', 'cpm-dia-mes', partes.mes)
          );
          const vagas = elc('span', 'cpm-dia-vagas cpm-esqueleto', '');
          b.appendChild(vagas);
          b.title = `${diaLegivel(data)} — consultando…`;
          b.addEventListener('click', () => escolherDia(data));
          const cartao = { botao: b, vagas, total: 0 };
          cartoes.set(data, cartao);
          dias.push(data);
          tira.appendChild(b);
          return cartao;
        }

        function pintarCartao(data, grade) {
          const c = cartoes.get(data);
          if (!c) return;
          const n = grade.disponiveis.length;
          c.total = n;
          c.vagas.className = 'cpm-dia-vagas';

          // Dia que a consulta não alcançou fica com "?" e CONTINUA clicável —
          // e nunca com "—". Os dois são coisas diferentes: "—" é agenda cheia,
          // "?" é o painel que não respondeu, e a falha não ficou no cache,
          // então clicar pergunta de novo. Mostrar "—" aqui seria a tela
          // afirmando que não há vaga sem ter perguntado.
          if (!grade.ok) {
            c.falhou = true;
            c.vagas.textContent = '?';
            c.botao.disabled = false;
            c.botao.title = `${diaLegivel(data)} — não consegui consultar, clique pra tentar`;
            c.botao.setAttribute('aria-label', `${diaLegivel(data)}, não consultado`);
            return;
          }

          // Dia sem vaga fica com o travessão e sem clique: é a informação que
          // faltava — dá pra ver o buraco na agenda sem entrar nele.
          c.falhou = false;
          c.vagas.textContent = n === 0 ? '—' : n === 1 ? '1 livre' : `${n} livres`;
          c.botao.disabled = n === 0;
          const detalhe =
            n > 0 ? `${n} ${n === 1 ? 'horário livre' : 'horários livres'}` : 'sem horário livre';
          c.botao.title = `${diaLegivel(data)} — ${detalhe}`;
          c.botao.setAttribute('aria-label', `${diaLegivel(data)}, ${detalhe}`);
        }

        function escolherDia(data) {
          diaEscolhido = data;
          seletorData.entrada.value = data;
          for (const [iso, c] of cartoes) {
            const escolhido = iso === data;
            c.botao.classList.toggle('cpm-dia--escolhido', escolhido);
            c.botao.setAttribute('aria-pressed', String(escolhido));
          }
          blocoHora.style.display = '';
          void mostrarHorarios(data);
        }

        async function mostrarHorarios(data) {
          lista.replaceChildren(elc('div', 'cpm-centro', 'Consultando horários livres…'));
          const grade = await buscarDia(data);
          // Trocou de dia enquanto a consulta voltava: a resposta é de outro dia.
          if (diaEscolhido !== data) return;

          // Clicar num dia "?" é uma segunda tentativa: o cartão tem que sair do
          // "?" e mostrar a contagem que acabou de chegar.
          pintarCartao(data, grade);
          revisarRecado();

          if (grade.disponiveis.length === 0) {
            const temOutro = dias.some((d) => (cartoes.get(d) || { total: 0 }).total > 0);
            lista.replaceChildren(
              elc(
                'div',
                'cpm-centro',
                grade.ok
                  ? `Sem horário livre em ${diaLegivel(data)}.` +
                      (temOutro ? ' Escolha um dia com vaga na tira acima.' : '')
                  : 'Não consegui falar com o painel agora.'
              )
            );
            return;
          }

          // `.cpm-horarios` e `.cpm-horario` são do design system da aba (moram
          // em aba-reuniao.js): grade, borda, hover e fonte saem de token e
          // acompanham a troca de tema.
          const grelha = elc('div', 'cpm-horarios');
          for (const hora of grade.disponiveis) {
            const b = elc('button', 'cpm-horario', hora);
            b.type = 'button';
            b.addEventListener('click', () => {
              // Verde no horário ANTES de sair da tela: entre o clique e o
              // "Marcando a reunião…" tem uma ida ao servidor, e sem retorno
              // visual a pessoa clica de novo — no painel, dois cliques viram
              // duas reuniões de verdade na agenda de alguém.
              for (const outro of grelha.children) {
                outro.classList.remove('cpm-horario--escolhido');
              }
              b.classList.add('cpm-horario--escolhido');
              estado.data = data;
              estado.hora = hora;
              // COM o fuso do navegador. O servidor exige offset de propósito:
              // "2026-08-17T09:00:00" solto seria lido como UTC, e o cliente
              // receberia "reunião às 6h" — três horas antes do combinado.
              confirmar(comFuso(data, hora));
            });
            grelha.appendChild(b);
          }
          lista.replaceChildren(grelha);

          // Bloqueados aparecem em cinza: sumir com eles faz o dia parecer "sem
          // grade", e o atendente não entende se é feriado ou lotação.
          if (grade.bloqueados.length > 0) {
            lista.appendChild(
              elc('div', 'cpm-recado', `Ocupados: ${grade.bloqueados.join(' · ')}`)
            );
          }
        }

        /**
         * `max_date` só chega junto com a primeira resposta, e a tira é montada
         * antes dela. O que passou do limite sai agora: oferecer dia que o POST
         * vai recusar é pedir pra pessoa preencher tudo e levar erro no fim.
         */
        function aparar() {
          for (let i = dias.length - 1; i >= 0; i -= 1) {
            const data = dias[i];
            if (data <= memoria.maxDate) continue;
            const c = cartoes.get(data);
            if (c) c.botao.remove();
            cartoes.delete(data);
            dias.splice(i, 1);
            if (diaEscolhido === data) {
              diaEscolhido = null;
              blocoHora.style.display = 'none';
            }
          }
          if (cursor > memoria.maxDate) esgotou = true;
        }

        /**
         * Uma página: os próximos dias úteis a partir do `cursor`.
         *
         * `forcarPrimeiro` entra pelo "Outra data" — o dia que a pessoa escolheu
         * a dedo aparece mesmo caindo num sábado, porque foi ela que escolheu.
         */
        async function carregarPagina(opcoes) {
          if (carregando) return;
          const forcarPrimeiro = Boolean(opcoes && opcoes.forcarPrimeiro);
          const preferir = (opcoes && opcoes.preferir) || null;
          const minhaGeracao = geracao;

          const novos = [];
          let passos = 0;
          // O teto de passos é só um freio: 7 dias úteis cabem em 9 dias
          // corridos, e nada aqui pode virar laço infinito na tela de alguém.
          while (novos.length < DIAS_POR_PAGINA && passos < 45) {
            if (memoria.maxDate && cursor > memoria.maxDate) break;
            if (ehDiaUtil(cursor) || (forcarPrimeiro && passos === 0)) novos.push(cursor);
            cursor = somarDias(cursor, 1);
            passos += 1;
          }
          if (novos.length === 0) {
            // Clicou "ver mais dias" e não há mais: sem uma frase aqui o botão
            // simplesmente sumiria e ninguém entenderia por quê.
            esgotou = true;
            atualizarAcoes();
            if (memoria.maxDate) {
              dizer(`A agenda do painel vai até ${diaLegivel(memoria.maxDate)}.`);
            }
            return;
          }

          carregando = true;
          btnMais.disabled = true;
          btnTentar.style.display = 'none';
          const primeiraPagina = dias.length === 0;
          for (const data of novos) cartaoDia(data);
          if (!primeiraPagina) rolarAte(novos[0]);

          // Uma chamada por dia porque é o que a API aceita (`available-slots`
          // recebe UMA data). Em paralelo porque em série seriam 7 idas e
          // voltas enfileiradas — a tira levaria segundos pra encher.
          const grades = await Promise.all(
            novos.map(async (data) => {
              const grade = await buscarDia(data);
              pintarCartao(data, grade);
              return grade;
            })
          );
          // A tira foi remontada enquanto isto voltava (a pessoa pulou pra outra
          // data): quem manda na tela agora é a carga nova.
          if (minhaGeracao !== geracao) return;
          carregando = false;
          btnMais.disabled = false;

          if (memoria.maxDate) {
            seletorData.entrada.max = memoria.maxDate;
            aparar();
          }
          atualizarAcoes();

          // Deixar a tela já num dia útil poupa um clique. A ordem é: o dia que
          // a pessoa pediu, o dia que ela já tinha escolhido antes, e só então o
          // primeiro com vaga.
          if (preferir && cartoes.has(preferir)) {
            escolherDia(preferir);
          } else if (!diaEscolhido) {
            const anterior =
              estado.data && cartoes.has(estado.data) && cartoes.get(estado.data).total > 0
                ? estado.data
                : null;
            const primeiroLivre = dias.find((d) => cartoes.get(d).total > 0);
            if (anterior || primeiroLivre) escolherDia(anterior || primeiroLivre);
          }

          revisarRecado();
        }

        /** Recomeça a tira num dia qualquer, sem carregar o que já passou. */
        function remontarTira(inicio, opcoes) {
          geracao += 1;
          carregando = false;
          tira.replaceChildren();
          cartoes.clear();
          dias.length = 0;
          diaEscolhido = null;
          esgotou = false;
          blocoHora.style.display = 'none';
          btnTentar.style.display = 'none';
          dizer('');
          cursor = inicio;
          atualizarAcoes();
          void carregarPagina(opcoes || {});
        }

        btnMais.addEventListener('click', () => {
          void carregarPagina({});
        });

        btnOutra.addEventListener('click', () => {
          const escondido = seletorData.wrap.style.display === 'none';
          seletorData.wrap.style.display = escondido ? '' : 'none';
          btnOutra.setAttribute('aria-expanded', String(escondido));
          if (!escondido) return;
          seletorData.entrada.focus();
          // `showPicker` abre o calendário direto. Sem ele a pessoa clica no
          // botão, o campo aparece, e ela ainda precisa achar o ícone dele.
          try {
            if (typeof seletorData.entrada.showPicker === 'function') {
              seletorData.entrada.showPicker();
            }
          } catch (_erro) {
            // Navegador que exige gesto próprio pro calendário: o campo já está
            // na tela e focado, dá pra digitar a data.
          }
        });

        seletorData.entrada.addEventListener('change', () => {
          const escolhida = seletorData.entrada.value;
          if (!escolhida) return;
          if (cartoes.has(escolhida)) {
            escolherDia(escolhida);
            rolarAte(escolhida);
            return;
          }
          // Dia longe da tira: a tira se muda pra lá, em vez de virar uma fila
          // de "ver mais dias" até chegar no mês que vem.
          remontarTira(escolhida, { forcarPrimeiro: true, preferir: escolhida });
        });

        btnTentar.addEventListener('click', () => {
          // A falha não foi guardada no cache, então remontar a mesma faixa de
          // dias pergunta de novo ao painel.
          remontarTira(dias[0] || hojeLocal(0), { forcarPrimeiro: true });
        });

        void carregarPagina({});
      }

      // ── Passo 5: confirma e cria ─────────────────────────────────────────
      async function confirmar(quandoIso) {
        // Em prévia paramos aqui, de propósito: o passo seguinte cria bot,
        // manda mensagem pro cliente e ocupa agenda. Nada disso pode acontecer
        // enquanto a tela está sendo conferida.
        if (estado.previa) {
          api.limpar();
          api.cabecalho('Reunião', null);
          const p = api.p;
          api.corpo.appendChild(
            api.el('div', 'font:600 15px/1.3 system-ui,sans-serif;margin-bottom:10px', 'Prévia')
          );
          const resumo = [
            `Tipo: ${TIPOS[estado.tipo].rotulo}`,
            `Cliente: ${estado.cliente.nome} · ${estado.cliente.empresa}`,
            `Telefone: ${estado.cliente.telefone}`,
          ];
          if (estado.cliente.cnpj) resumo.push(`CNPJ: ${estado.cliente.cnpj}`);
          if (estado.cliente.instancia) resumo.push(`Instância: ${estado.cliente.instancia}`);
          if (estado.cliente.provedor) resumo.push(`Provedor: ${estado.cliente.provedor}`);
          if (estado.cliente.csReason) {
            const motivo = MOTIVOS_CS.find(([v]) => v === estado.cliente.csReason);
            resumo.push(`Motivo: ${motivo ? motivo[1] : estado.cliente.csReason}`);
          }
          if (estado.vendedorEmail) resumo.push(`Vendedor da conta: ${estado.vendedorEmail}`);
          resumo.push(
            estado.assigneeEmail
              ? `Quem conduz: ${estado.assigneeEmail}`
              : 'Quem conduz: definido pelo painel'
          );
          resumo.push(
            quandoIso ? `Quando: ${diaLegivel(estado.data)} às ${estado.hora}` : 'Quando: agora'
          );
          for (const linha of resumo) {
            api.corpo.appendChild(
              api.el(
                'div',
                `font:400 12px/1.7 system-ui,sans-serif;color:${p.textoFraco}`,
                linha
              )
            );
          }
          api.corpo.appendChild(
            api.el(
              'div',
              `margin-top:14px;padding:10px 12px;border-radius:${p.blocoRaio};background:${p.fundoFraco};` +
                `font:500 12px/1.5 system-ui,sans-serif;color:${p.textoFraco}`,
              'Nada foi criado. Com o painel configurado, aqui a reunião seria ' +
                'marcada, o link gerado e o cliente avisado.'
            )
          );
          api.acao('Fechar', api.fechar);
          return;
        }

        api.carregando(quandoIso ? 'Marcando a reunião…' : 'Criando a sala…');
        api.cabecalho('Reunião', null);

        const bruto = await pedir('INICIAR_REUNIAO', {
          sessionId: sessaoOrigem,
          contato: estado.cliente.nome,
          quando: quandoIso,
          tipoReuniao: estado.tipo,
          atendenteEmail: estado.eu.email,
          // Vem do JWT do chatPro: é com ele que o comentário na conversa fica
          // no nome de quem conduziu, em vez do usuário fixo do .env.
          atendenteUserId: estado.eu.userId || null,
          cliente: estado.cliente,
          vendedorEmail: estado.vendedorEmail,
          // Só existe quando o painel disse que esta pessoa escolhe — mandar
          // sem permissão é 403 na cara de quem já preencheu tudo.
          assigneeEmail: estado.assigneeEmail,
        }).catch((err) => ({ ok: false, erro: String(err) }));

        // O service worker embrulha em { ok, dados, erro }; a partir daqui a
        // aba só lida com o conteúdo.
        const resposta =
          bruto && bruto.ok
            ? bruto.dados || {}
            : Object.assign({ erro: (bruto && bruto.erro) || 'Não consegui falar com o servidor.' }, bruto || {});

        api.limpar();
        const p = api.p;

        if (!bruto || !bruto.ok) {
          const msg = resposta.erro || resposta.error;
          api.corpo.appendChild(
            api.el(
              'div',
              `font:600 14px/1.4 system-ui,sans-serif;color:${p.perigo};margin-bottom:8px`,
              String(msg)
            )
          );
          const detalhe = resposta.detalhe || resposta.detail;
          if (detalhe) {
            api.corpo.appendChild(
              api.el(
                'div',
                `font:400 12px/1.5 system-ui,sans-serif;color:${p.textoFraco}`,
                String(detalhe)
              )
            );
          }

          // "Tentar de novo" NÃO pode aparecer quando o servidor avisa que
          // repetir é perigoso. O POST pode ter criado a reunião no painel
          // (link gerado, agenda ocupada, Slack avisado) e só a resposta ter se
          // perdido — a API não tem chave de idempotência, então o segundo
          // clique vira um segundo compromisso real na agenda de alguém.
          if (resposta.naoRepetir || resposta.incerto) {
            api.corpo.appendChild(
              api.el(
                'div',
                `margin-top:12px;padding:10px 12px;border-radius:${p.blocoRaio};background:${p.fundoFraco};` +
                  `font:500 12px/1.5 system-ui,sans-serif;color:${p.texto}`,
                'Confira no painel de reuniões antes de marcar de novo — se ela já ' +
                  'estiver lá, marcar outra vez cria uma reunião duplicada.'
              )
            );
            if (resposta.meetUrl) {
              api.acao('Copiar o link mesmo assim', () => {
                void navigator.clipboard.writeText(resposta.meetUrl).catch(() => {});
              });
            } else {
              api.acao('Fechar', api.fechar);
            }
            return;
          }

          // 409 no horário: a grade é uma fotografia e alguém ocupou entre
          // consultar e confirmar. Voltar pra grade é a saída certa.
          if (resposta.recarregarHorarios) {
            api.acao('Escolher outro horário', passoHorario);
            return;
          }

          // Checklist de migração faltando. "Tentar de novo" aqui falharia
          // igual — o que resolve é gerar o onboarding, e o link é gerado
          // DURANTE a migração no fluxo do time. Então o botão é esse, na
          // própria tela do erro, em vez de mandar a pessoa embora.
          const textoDoErro = `${msg || ''} ${detalhe || ''}`;
          const faltaChecklist = /checklist/i.test(textoDoErro) && estado.tipo === 'migracao';
          if (faltaChecklist && estado.cliente && estado.cliente.cnpj) {
            const btn = api.acao('Gerar o link do onboarding', async () => {
              btn.disabled = true;
              btn.textContent = 'Gerando…';
              const r = await pedir('PAINEL_GERAR_MIGRACAO', {
                cnpj: estado.cliente.cnpj,
                vendedorEmail: estado.vendedorEmail || '',
                instanceCode: estado.cliente.instancia || '',
              }).catch(() => null);

              if (r && r.ok) {
                // Gerado: repete a marcação, que agora tem o que faltava.
                confirmar(quandoIso);
                return;
              }
              btn.disabled = false;
              btn.textContent = 'Gerar o link do onboarding';
              nota(
                (r && (r.detail || r.error)) || 'Não deu pra gerar o link agora.',
                'perigo'
              );
            });
            return;
          }

          api.acao('Tentar de novo', passoDados);
          return;
        }

        // ── O cartão de confirmação ────────────────────────────────────────
        //
        // Mesma estrutura da lista do Copiloto: `header h1` + `article` com as
        // linhas. Antes eram três frases soltas e o atendente tinha que ler
        // tudo pra achar o horário; aqui rótulo e valor ficam em colunas.
        //
        // Os ajudantes moram DENTRO de confirmar de propósito: são só deste
        // passo, e os passos acima estão sendo mexidos em paralelo.
        //
        // Toda cor sai de token. As `--gray-*` invertem entre tema claro e
        // escuro — hex fixo aqui já quebrou o cartão no claro uma vez.

        const SEMANA_LONGA = [
          'domingo',
          'segunda-feira',
          'terça-feira',
          'quarta-feira',
          'quinta-feira',
          'sexta-feira',
          'sábado',
        ];
        const MESES = [
          'janeiro',
          'fevereiro',
          'março',
          'abril',
          'maio',
          'junho',
          'julho',
          'agosto',
          'setembro',
          'outubro',
          'novembro',
          'dezembro',
        ];
        /** Em nome próprio elas ficam minúsculas: "Maria de Souza". */
        const PARTICULAS = ['de', 'da', 'do', 'das', 'dos', 'e'];

        const ESTILO_LINHA =
          'display:flex;gap:.75rem;justify-content:space-between;align-items:baseline;' +
          `padding:.5rem 0;border-bottom:1px solid ${p.fundoFraco}`;
        const ESTILO_ROTULO = `flex:0 0 auto;font-size:.75rem;color:${p.textoFraco}`;
        const ESTILO_VALOR =
          `flex:1 1 auto;min-width:0;text-align:right;word-break:break-word;` +
          `font-size:.8125rem;color:${p.texto}`;

        /**
         * Quando por extenso, a partir do que a PESSOA escolheu (`YYYY-MM-DD` e
         * `HH:MM`, sem fuso no meio). O `quandoTexto` do servidor é a versão
         * curta ("quarta, 03/09") e fica de reserva.
         */
        function quandoPorExtenso() {
          if (!quandoIso) return 'agora';
          const [ano, mes, dia] = String(estado.data || '').split('-').map(Number);
          const [hh, mm] = String(estado.hora || '').split(':');
          if (!Number.isFinite(ano) || !Number.isFinite(mes) || !Number.isFinite(dia) || !hh) {
            return resposta.quandoTexto ? String(resposta.quandoTexto) : '';
          }
          const semana = SEMANA_LONGA[new Date(ano, mes - 1, dia).getDay()];
          // "11h" lê melhor que "11h00"; o minuto só aparece quando existe.
          const hora = `${Number(hh)}h${mm && mm !== '00' ? mm : ''}`;
          return `${semana}, ${dia} de ${MESES[mes - 1]}, às ${hora}`;
        }

        /** "anna.souza@chatpro.com.br" → "Anna Souza". */
        function humanizarEmail(email) {
          const partes = String(email).split('@')[0].split(/[._-]+/).filter(Boolean);
          if (partes.length === 0) return String(email);
          return partes
            .map((parte, i) => {
              const t = parte.toLowerCase();
              if (i > 0 && PARTICULAS.includes(t)) return t;
              return t.charAt(0).toUpperCase() + t.slice(1);
            })
            .join(' ');
        }

        /**
         * A rota devolve o E-MAIL do responsável — o nome que o painel manda no
         * 201 dele para no servidor. Quando o e-mail é o de quem está marcando,
         * o nome já está em mãos; nos outros casos o e-mail vira nome legível.
         * O objeto `{name,email}` também é aceito, pra não quebrar se um dia a
         * rota repassar o que o painel manda.
         */
        function nomeDoResponsavel() {
          const bruto = resposta.responsavel;
          const cru =
            bruto && typeof bruto === 'object'
              ? String(bruto.nome || bruto.name || bruto.email || '')
              : String(bruto || '');
          if (!cru) return null;
          if (!cru.includes('@')) return cru;
          if (estado.eu && estado.eu.email === cru && estado.eu.nome) return estado.eu.nome;
          return humanizarEmail(cru);
        }

        /**
         * Como a reunião foi atribuída. A resposta ainda não traz o
         * `assignment_mode`, então ele é deduzido do que aconteceu aqui:
         * escolher alguém no formulário é `explicit`; deixar em automático cai
         * na distribuição, mesmo quando a pessoa PODIA escolher.
         */
        function modoDaAtribuicao() {
          const doServidor = resposta.assignmentMode || resposta.assignment_mode;
          if (doServidor) return String(doServidor);
          const email = typeof resposta.responsavel === 'string' ? resposta.responsavel : null;
          if (email && estado.eu && email === estado.eu.email) return 'self';
          // `assigneeEmail` é quem CONDUZ, escolhido no formulário. Não confundir
          // com `vendedorEmail`, que é o dono da conta e a migração sempre manda
          // — por ele, toda migração viraria "escolhido".
          if (estado.assigneeEmail) return 'explicit';
          return (estado.capacidade && estado.capacidade.assignment) || null;
        }

        function linha(destino, rotulo, valor) {
          if (!valor) return null; // linha vazia é ruído, não informação
          const l = api.el('div', ESTILO_LINHA);
          l.append(api.el('span', ESTILO_ROTULO, rotulo), api.el('span', ESTILO_VALOR, valor));
          destino.appendChild(l);
          return l;
        }

        /** `.cpm-nota` é a caixa do design system: fundo --gray-10 e raio deles. */
        function nota(texto, tom) {
          const n = api.el(
            'div',
            'margin-top:.75rem' +
              (tom === 'perigo' ? `;border-left:3px solid ${p.perigo}` : ''),
            texto
          );
          n.className = 'cpm-nota';
          api.corpo.appendChild(n);
          return n;
        }

        /**
         * `navigator.clipboard` é negado quando a aba não está em foco ou o
         * contexto não é seguro. O caminho antigo ainda funciona no content
         * script, e é a diferença entre colar na conversa e digitar de novo.
         */
        async function copiarTexto(texto) {
          try {
            await navigator.clipboard.writeText(texto);
            return true;
          } catch {
            try {
              const t = document.createElement('textarea');
              t.value = texto;
              t.setAttribute('readonly', '');
              t.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
              document.body.appendChild(t);
              t.select();
              const ok = document.execCommand('copy');
              t.remove();
              return ok;
            } catch {
              return false;
            }
          }
        }

        /** Confirma no próprio botão e volta ao rótulo — sem alert, sem cor nova. */
        function responder(botao, rotulo, ok) {
          botao.textContent = ok ? 'Copiado' : 'Não consegui copiar';
          setTimeout(() => {
            botao.textContent = rotulo;
          }, 2000);
        }

        const rotuloTipo = (TIPOS[estado.tipo] && TIPOS[estado.tipo].rotulo) || null;
        const cliente = [estado.cliente.nome, estado.cliente.empresa].filter(Boolean).join(' · ');
        const quandoTexto = quandoPorExtenso();
        const responsavel = nomeDoResponsavel();
        const modo = modoDaAtribuicao();
        const rotuloModo =
          modo === 'self'
            ? 'ficou com você'
            : modo === 'round_robin'
              ? 'entrou na distribuição'
              : modo === 'explicit'
                ? 'escolhido'
                : null;

        const artigo = api.secao(quandoIso ? 'Reunião marcada' : 'Reunião criada');
        linha(artigo, 'Tipo', rotuloTipo);
        linha(artigo, 'Cliente', cliente);
        linha(artigo, 'Quando', quandoTexto);
        linha(
          artigo,
          'Responsável',
          responsavel ? `${responsavel}${rotuloModo ? ` · ${rotuloModo}` : ''}` : null
        );

        // O link fica em coluna: uma URL do Meet não cabe ao lado do rótulo.
        // E fica DENTRO de uma div — `.copilot-list > article > a` é a regra
        // dos cartões de duas linhas e transformaria isto num deles.
        if (resposta.meetUrl) {
          const bloco = api.el(
            'div',
            'display:flex;flex-direction:column;gap:.25rem;padding:.5rem 0'
          );
          bloco.appendChild(api.el('span', ESTILO_ROTULO, 'Link'));
          const link = api.el(
            'a',
            `font-size:.8125rem;color:${p.verde};word-break:break-all;text-decoration:none`,
            String(resposta.meetUrl)
          );
          link.href = String(resposta.meetUrl);
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          bloco.appendChild(link);
          artigo.appendChild(bloco);
        }
        // A última linha não fecha com borda — senão o cartão fica com um
        // risco solto embaixo, que lê como "tem mais coisa cortada".
        if (artigo.lastElementChild) artigo.lastElementChild.style.borderBottom = 'none';

        // O que acontece a seguir. `avisoMensagem` e "link já foi enviado"
        // nunca aparecem juntos: o servidor só manda o aviso quando o envio
        // falhou — e aí a reunião existe mas o cliente NÃO foi avisado, o que
        // precisa ficar na cara, senão o atendente fecha a aba achando que
        // acabou e ninguém aparece na sala.
        // O painel não respondeu e a reunião saiu pelo plano B: ela EXISTE pro
        // cliente e NÃO existe no painel. Vem primeiro, e em tom de perigo,
        // porque é a única pendência que sobra na mão do atendente — o servidor
        // já mandava `avisoPainel` e ninguém mostrava, então a tela de sucesso
        // dizia "marcada" pra uma reunião que o painel nunca viu.
        if (resposta.avisoPainel) nota(String(resposta.avisoPainel), 'perigo');

        if (resposta.avisoMensagem) nota(String(resposta.avisoMensagem), 'perigo');
        else if (quandoIso) nota('O convite vai pro cliente 5 minutos antes.');
        else if (resposta.mensagemEnviada) nota('O link já foi enviado pro cliente.');
        // A sala abriu, mas o bot não entrou: sem isto, a pessoa só descobre
        // que não há transcrição quando for procurar por ela.
        if (resposta.avisoGravacao) nota(String(resposta.avisoGravacao), 'perigo');

        // ── O resumo pra colar na conversa ─────────────────────────────────
        //
        // Este texto vai pro WhatsApp DO CLIENTE: nada de markdown (o WhatsApp
        // não renderiza tabela) e nada de dado interno — telefone, CNPJ, código
        // da instância e e-mail de quem atende ficam no cartão, não aqui.
        const textoResumo = [
          `✅ ${rotuloTipo ? `Reunião de ${rotuloTipo}` : 'Reunião'} ` +
            `${quandoIso ? 'marcada' : 'criada'}`,
          cliente ? `Cliente: ${cliente}` : null,
          quandoTexto ? `Quando: ${quandoTexto}` : null,
          responsavel ? `Responsável: ${responsavel}` : null,
          resposta.meetUrl ? `Link: ${resposta.meetUrl}` : null,
        ]
          .filter(Boolean)
          .join('\n');

        const copiarResumo = api.botao('Copiar resumo');
        copiarResumo.style.cssText = 'width:100%;margin-top:1rem';
        copiarResumo.addEventListener('click', () => {
          void copiarTexto(textoResumo).then((ok) =>
            responder(copiarResumo, 'Copiar resumo', ok)
          );
        });
        api.corpo.appendChild(copiarResumo);

        if (resposta.meetUrl) {
          const acao = api.acao(quandoIso ? 'Copiar link' : 'Entrar na reunião', () => {
            if (!quandoIso) {
              window.open(resposta.meetUrl, '_blank', 'noopener');
              api.fechar();
              return;
            }
            void copiarTexto(resposta.meetUrl).then((ok) =>
              responder(acao, 'Copiar link', ok)
            );
          });
        } else {
          api.acao('Fechar', api.fechar);
        }
      }

      void passoIdentidade();
    });
  }

  window.__cpmFluxo = { iniciar };
})();
