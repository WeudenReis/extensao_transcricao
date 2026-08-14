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

  const TIPOS = {
    apresentacao: { rotulo: 'Apresentação', cor: '#3b82f6' },
    migracao: { rotulo: 'Migração', cor: '#f59e0b' },
    implantacao: { rotulo: 'Implantação', cor: '#8b5cf6' },
    cs: { rotulo: 'CS', cor: '#25D066' },
  };
  /** Estes três não sobem sem os dados cadastrais do cliente. */
  const COM_DADOS = ['migracao', 'implantacao', 'cs'];
  const PROVEDORES = [
    ['starter', 'Starter'],
    ['cloud_api', 'Cloud API'],
    ['api_disparos', 'API de disparos'],
  ];

  // ─── Máscaras e validação ──────────────────────────────────────────────────

  function mascararCnpj(v) {
    const d = v.replace(/\D/g, '').slice(0, 14);
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
    if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
    if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  function mascararTelefone(v) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
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

  function diaLegivel(iso) {
    const [a, m, d] = iso.split('-').map(Number);
    const data = new Date(a, m - 1, d);
    const semana = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    return `${semana[data.getDay()]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  }

  // ─── O fluxo ───────────────────────────────────────────────────────────────

  function iniciar(contexto) {
    const aba = window.__cpmAba;
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
        vendedorEmail: null,
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
          resposta = { erro: String(err) };
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

        if (estado.eu && estado.eu.nome) {
          api.corpo.appendChild(
            api.el(
              'div',
              `margin-bottom:16px;font:400 12px/1.4 system-ui,sans-serif;color:${p.textoFraco}`,
              `Marcando como ${estado.eu.nome}${estado.eu.papel ? ` · ${estado.eu.papel}` : ''}`
            )
          );
        }

        const opcoes = [
          ['agora', 'Reunir agora', 'Cria a sala e manda o link pro cliente na hora.'],
          ['marcar', 'Marcar para depois', 'Escolhe dia e horário livres. O convite sai 5 min antes.'],
        ];
        for (const [chave, titulo, ajuda] of opcoes) {
          const cartao = api.el(
            'button',
            [
              'display:block',
              'width:100%',
              'text-align:left',
              'padding:14px',
              'margin-bottom:10px',
              'border-radius:12px',
              `border:1px solid ${p.borda}`,
              'background:transparent',
              `color:${p.texto}`,
              'cursor:pointer',
            ].join(';')
          );
          cartao.type = 'button';
          cartao.appendChild(
            api.el('div', 'font:600 14px/1.3 system-ui,sans-serif;margin-bottom:4px', titulo)
          );
          cartao.appendChild(
            api.el(
              'div',
              `font:400 12px/1.4 system-ui,sans-serif;color:${p.textoFraco}`,
              ajuda
            )
          );
          cartao.addEventListener('mouseenter', () => {
            cartao.style.background = p.fundoFraco;
            cartao.style.borderColor = p.verde;
          });
          cartao.addEventListener('mouseleave', () => {
            cartao.style.background = 'transparent';
            cartao.style.borderColor = p.borda;
          });
          cartao.addEventListener('click', () => {
            estado.modo = chave;
            passoTipo();
          });
          api.corpo.appendChild(cartao);
        }
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

        for (const cap of permitidos) {
          const meta = TIPOS[cap.type];
          if (!meta) continue;
          const b = api.el(
            'button',
            [
              'display:flex',
              'align-items:center',
              'gap:10px',
              'width:100%',
              'text-align:left',
              'padding:13px 14px',
              'margin-bottom:9px',
              'border-radius:12px',
              `border:1px solid ${p.borda}`,
              'background:transparent',
              `color:${p.texto}`,
              'cursor:pointer',
            ].join(';')
          );
          b.type = 'button';
          b.appendChild(
            api.el(
              'span',
              `width:8px;height:8px;border-radius:50%;background:${meta.cor};flex:0 0 auto`
            )
          );
          const bloco = api.el('span', 'flex:1');
          bloco.appendChild(
            api.el('span', 'display:block;font:600 14px/1.3 system-ui,sans-serif', meta.rotulo)
          );
          // O modo de atribuição muda o que vai acontecer — dizer antes evita
          // a surpresa de marcar e a reunião cair pra outra pessoa.
          const explica =
            cap.assignment === 'self'
              ? 'fica com você'
              : cap.assignment === 'round_robin'
                ? 'entra na distribuição'
                : 'você escolhe o responsável';
          bloco.appendChild(
            api.el(
              'span',
              `display:block;font:400 11px/1.4 system-ui,sans-serif;color:${p.textoFraco}`,
              explica
            )
          );
          b.appendChild(bloco);
          b.addEventListener('mouseenter', () => {
            b.style.background = p.fundoFraco;
          });
          b.addEventListener('mouseleave', () => {
            b.style.background = 'transparent';
          });
          b.addEventListener('click', () => {
            estado.tipo = cap.type;
            estado.capacidade = cap;
            passoDados();
          });
          api.corpo.appendChild(b);
        }
      }

      // ── Passo 3: dados do cliente ────────────────────────────────────────
      function passoDados() {
        api.limpar();
        api.cabecalho(TIPOS[estado.tipo].rotulo, passoTipo);
        const p = api.p;
        const precisaCadastro = COM_DADOS.includes(estado.tipo);

        const nome = api.campo('Nome do contato', { placeholder: 'Quem vai participar' });
        const empresa = api.campo('Empresa', { placeholder: 'Razão social' });
        const telefone = api.campo('Telefone', { placeholder: '(11) 90000-0000' });
        api.corpo.append(nome.wrap, empresa.wrap, telefone.wrap);

        // O que já dá pra saber da conversa entra preenchido — o atendente
        // confere em vez de digitar.
        if (contexto.contato) nome.entrada.value = contexto.contato;
        if (contexto.telefone) telefone.entrada.value = mascararTelefone(contexto.telefone);

        telefone.entrada.addEventListener('input', () => {
          const pos = telefone.entrada.value.length;
          telefone.entrada.value = mascararTelefone(telefone.entrada.value);
          if (pos >= telefone.entrada.value.length) telefone.entrada.setSelectionRange(999, 999);
        });

        let cnpj = null;
        let instancia = null;
        let provedor = null;
        let clientType = null;

        if (precisaCadastro) {
          cnpj = api.campo('CNPJ', { placeholder: '00.000.000/0000-00' });
          instancia = api.campo('Código da instância', { placeholder: 'chatpro-xxxxxxxxxx' });
          api.corpo.append(cnpj.wrap, instancia.wrap);

          cnpj.entrada.addEventListener('input', () => {
            cnpj.entrada.value = mascararCnpj(cnpj.entrada.value);
            const completo = cnpj.entrada.value.replace(/\D/g, '').length === 14;
            if (completo && !cnpjValido(cnpj.entrada.value)) {
              cnpj.erro.textContent = 'CNPJ inválido — confira os dígitos.';
              cnpj.erro.style.display = 'block';
            } else {
              cnpj.erro.style.display = 'none';
              // Migração: com CNPJ válido dá pra ver se o checklist existe. Sem
              // checklist ativo o painel recusa a reunião, e é melhor saber
              // agora do que depois do formulário inteiro.
              if (completo && estado.tipo === 'migracao') conferirChecklist(cnpj.entrada.value);
            }
          });

          // Migração distingue cliente da base de prospect: são pools
          // diferentes de condutores, e o errado devolve a grade da outra fila.
          if (estado.tipo === 'migracao') {
            clientType = api.campo('Tipo de cliente', { select: true });
            for (const [v, r] of [
              ['base', 'Já é cliente (base)'],
              ['prospect', 'Ainda não é cliente (prospect)'],
            ]) {
              const o = document.createElement('option');
              o.value = v;
              o.textContent = r;
              clientType.entrada.appendChild(o);
            }
            api.corpo.appendChild(clientType.wrap);
          }

          // Implantação e CS não sobem sem provedor — o painel devolve 422.
          if (estado.tipo === 'implantacao' || estado.tipo === 'cs') {
            provedor = api.campo('Provedor', { select: true });
            for (const [v, r] of PROVEDORES) {
              const o = document.createElement('option');
              o.value = v;
              o.textContent = r;
              provedor.entrada.appendChild(o);
            }
            api.corpo.appendChild(provedor.wrap);
          }
        }

        let avisoChecklist = null;
        async function conferirChecklist(valor) {
          if (avisoChecklist) avisoChecklist.remove();
          const r = await pedir('PAINEL_MIGRACAO_STATUS', { cnpj: valor }).catch(() => null);
          if (r && r.encontrado === false) {
            avisoChecklist = api.aviso(
              'Esse CNPJ ainda não tem checklist de migração ativo. ' +
                'O painel pode recusar a reunião.',
              'erro'
            );
          }
        }

        // Seletor de vendedor: só quando o painel disse que esta pessoa
        // escolhe o responsável.
        let vendedor = null;
        if (estado.capacidade && estado.capacidade.can_choose_assignee) {
          vendedor = api.campo('Responsável', { select: true });
          const vazio = document.createElement('option');
          vazio.value = '';
          vazio.textContent = 'Distribuir automaticamente';
          vendedor.entrada.appendChild(vazio);
          api.corpo.appendChild(vendedor.wrap);
          pedir('PAINEL_VENDEDORES')
            .then((r) => {
              for (const v of (r && r.vendedores) || []) {
                const o = document.createElement('option');
                o.value = v.email;
                o.textContent = v.nome;
                vendedor.entrada.appendChild(o);
              }
            })
            .catch(() => {});
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
          }
          estado.vendedorEmail = vendedor ? vendedor.entrada.value || null : null;

          if (estado.modo === 'agora') confirmar(null);
          else passoHorario();
        });
      }

      // ── Passo 4: dia e horário, da grade real ────────────────────────────
      function passoHorario() {
        api.limpar();
        api.cabecalho('Quando', passoDados);
        const p = api.p;

        let dataEscolhida = hojeLocal(1);
        const seletorData = api.campo('Dia', { tipo: 'date' });
        seletorData.entrada.value = dataEscolhida;
        seletorData.entrada.min = hojeLocal(0);
        api.corpo.appendChild(seletorData.wrap);

        const lista = api.el('div', 'margin-top:4px');
        api.corpo.appendChild(lista);

        async function carregarGrade() {
          lista.replaceChildren(
            api.el(
              'div',
              `padding:18px 4px;color:${p.textoFraco};font:500 12px/1.4 system-ui,sans-serif`,
              'Consultando horários livres…'
            )
          );
          const r = await pedir('PAINEL_HORARIOS', {
            tipoReuniao: estado.tipo,
            data: dataEscolhida,
            email: estado.eu.email,
            clientType: estado.cliente.clientType || null,
          }).catch(() => null);

          let grade = (r && r.grade) || { disponiveis: [], bloqueados: [], maxDate: null };

          // Em prévia a grade real não existe. Mostramos uma grade comercial
          // padrão pra dar pra ver a tela — e a faixa de aviso continua no
          // topo, então ninguém confunde isso com disponibilidade de verdade.
          if (estado.previa && grade.disponiveis.length === 0) {
            grade = {
              disponiveis: ['09:00', '09:30', '10:00', '11:00', '14:00', '14:30', '15:00', '16:30'],
              bloqueados: ['10:30', '13:30'],
              maxDate: null,
            };
          }
          // max_date: o POST recusa além disso. Não deixar escolher evita o
          // usuário marcar uma data que o servidor vai rejeitar.
          if (grade.maxDate) seletorData.entrada.max = grade.maxDate;

          lista.replaceChildren();
          if (grade.disponiveis.length === 0) {
            lista.appendChild(
              api.el(
                'div',
                `padding:18px 4px;color:${p.textoFraco};font:500 12px/1.5 system-ui,sans-serif`,
                r && r.disponivel === false
                  ? 'Não consegui falar com o painel agora.'
                  : `Sem horário livre em ${diaLegivel(dataEscolhida)}. Tente outro dia.`
              )
            );
            return;
          }

          const grade2 = api.el(
            'div',
            'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px'
          );
          for (const hora of grade.disponiveis) {
            const b = api.el(
              'button',
              [
                'padding:9px 4px',
                'border-radius:9px',
                `border:1px solid ${p.borda}`,
                'background:transparent',
                `color:${p.texto}`,
                'font:600 13px/1 system-ui,sans-serif',
                'cursor:pointer',
              ].join(';'),
              hora
            );
            b.type = 'button';
            b.addEventListener('mouseenter', () => {
              b.style.borderColor = p.verde;
            });
            b.addEventListener('mouseleave', () => {
              b.style.borderColor = p.borda;
            });
            b.addEventListener('click', () => {
              estado.data = dataEscolhida;
              estado.hora = hora;
              confirmar(`${dataEscolhida}T${hora}:00`);
            });
            grade2.appendChild(b);
          }
          lista.appendChild(grade2);

          // Bloqueados aparecem em cinza: some da lista o dia inteiro parece
          // "sem grade", e o atendente não entende se é feriado ou lotação.
          if (grade.bloqueados.length > 0) {
            lista.appendChild(
              api.el(
                'div',
                `margin-top:12px;color:${p.textoFraco};font:400 11px/1.4 system-ui,sans-serif`,
                `Ocupados: ${grade.bloqueados.join(' · ')}`
              )
            );
          }
        }

        seletorData.entrada.addEventListener('change', () => {
          dataEscolhida = seletorData.entrada.value;
          if (dataEscolhida) void carregarGrade();
        });
        void carregarGrade();
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
              `margin-top:14px;padding:10px 12px;border-radius:10px;background:${p.fundoFraco};` +
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
                `margin-top:12px;padding:10px 12px;border-radius:10px;background:${p.fundoFraco};` +
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
          } else {
            api.acao('Tentar de novo', passoDados);
          }
          return;
        }

        api.corpo.appendChild(
          api.el(
            'div',
            `font:600 15px/1.3 system-ui,sans-serif;margin-bottom:10px`,
            quandoIso ? 'Reunião marcada' : 'Reunião criada'
          )
        );
        // A reunião existe, mas o cliente NÃO foi avisado — e isso precisa ficar
        // na cara, senão o atendente fecha a aba achando que acabou e ninguém
        // aparece na sala.
        if (resposta.avisoMensagem) {
          api.corpo.appendChild(
            api.el(
              'div',
              `margin-bottom:12px;padding:10px 12px;border-radius:10px;` +
                `background:${p.fundoFraco};border-left:3px solid ${p.perigo};` +
                `font:500 12px/1.5 system-ui,sans-serif;color:${p.texto}`,
              String(resposta.avisoMensagem)
            )
          );
        }

        const detalhes = [];
        if (resposta.responsavel) detalhes.push(`Responsável: ${resposta.responsavel}`);
        if (quandoIso && resposta.quandoTexto) detalhes.push(`Quando: ${resposta.quandoTexto}`);
        if (quandoIso) detalhes.push('O convite vai pro cliente 5 minutos antes.');
        else if (resposta.mensagemEnviada) detalhes.push('O link já foi enviado pro cliente.');
        for (const linha of detalhes) {
          api.corpo.appendChild(
            api.el(
              'div',
              `font:400 12px/1.6 system-ui,sans-serif;color:${p.textoFraco}`,
              linha
            )
          );
        }

        if (resposta.meetUrl) {
          api.acao(quandoIso ? 'Copiar link' : 'Entrar na reunião', () => {
            if (quandoIso) {
              void navigator.clipboard.writeText(resposta.meetUrl).catch(() => {});
            } else {
              window.open(resposta.meetUrl, '_blank', 'noopener');
              api.fechar();
            }
          });
        }
      }

      void passoIdentidade();
    });
  }

  window.__cpmFluxo = { iniciar };
})();
