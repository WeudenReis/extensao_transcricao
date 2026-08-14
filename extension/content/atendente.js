/**
 * Quem é o atendente que está usando o chatPro agora.
 *
 * Este e-mail é a peça central do fluxo: é o `actor_email` de toda chamada ao
 * painel, e é ele que decide o que a pessoa pode marcar e para quem a reunião
 * vai. Errar aqui não dá erro na tela — dá reunião atribuída à pessoa errada.
 *
 * O PROBLEMA: o formato do `@chatpro:auth` não é documentado, e o chatPro pode
 * mudá-lo sem avisar. Depender de um caminho fixo (`auth.user.email`) seria
 * garantir que um dia isso quebra em silêncio.
 *
 * A SOLUÇÃO: seis fontes, tentadas em ordem de confiabilidade, e a primeira que
 * devolver um e-mail plausível vence. Cada uma registra COMO achou, então
 * quando quebrar dá pra ver no console qual caminho parou de funcionar em vez
 * de adivinhar.
 *
 *   1. @chatpro:auth → JSON, procurando chaves com "mail" em qualquer nível
 *   2. @chatpro:auth → JWT (o valor costuma ser token; o e-mail está no payload)
 *   3. @chatpro:auth → regex de e-mail no valor cru
 *   4. qualquer chave do localStorage que comece com @chatpro: (1 a 3 de novo)
 *   5. sessionStorage, mesmo tratamento
 *   6. o DOM do menu de usuário
 *
 * O resultado é confirmado contra o painel (`/api/painel/me`): se o painel não
 * reconhece o e-mail como usuário ativo, ele não serve, e a tela diz isso em
 * vez de deixar o atendente preencher tudo pra levar 422 no fim.
 */

(() => {
  'use strict';

  const CHAVE = '@chatpro:auth';
  const PREFIXO = '@chatpro:';
  /** Cache curto: ler localStorage a cada clique é barato, mas o parse não. */
  const VALIDADE_MS = 60_000;

  let cache = null;

  /**
   * Um e-mail plausível de atendente. Descarta os falsos positivos comuns em
   * blobs de configuração — `no-reply@`, `exemplo@`, `sentry@` e afins entram
   * em payloads de app com frequência e virariam o "atendente".
   */
  const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const LIXO = /^(no-?reply|noreply|exemplo|example|test|sentry|suporte@sentry)/i;
  const DOMINIO_LIXO = /(sentry\.io|example\.com|exemplo\.com)$/i;

  function ehEmailUtil(valor) {
    if (typeof valor !== 'string') return false;
    const m = RE_EMAIL.exec(valor.trim());
    if (!m) return false;
    const email = m[0].toLowerCase();
    const local = email.split('@')[0];
    return !LIXO.test(local) && !DOMINIO_LIXO.test(email);
  }

  function extrairEmail(valor) {
    const m = RE_EMAIL.exec(String(valor));
    return m ? m[0].toLowerCase() : null;
  }

  /**
   * Vasculha um objeto inteiro atrás de e-mail, priorizando chaves que se
   * parecem com e-mail ("email", "userEmail", "mail"). A prioridade importa:
   * um payload pode ter o e-mail do atendente E o de suporte, e sem preferir a
   * chave certa a busca devolveria o primeiro que aparecesse.
   */
  function procurarNoObjeto(raiz) {
    const fila = [raiz];
    const candidatos = [];
    let visitados = 0;

    while (fila.length > 0 && visitados < 500) {
      const atual = fila.shift();
      visitados += 1;
      if (atual === null || typeof atual !== 'object') continue;

      for (const [chave, valor] of Object.entries(atual)) {
        if (typeof valor === 'string') {
          if (!ehEmailUtil(valor)) continue;
          const nome = chave.toLowerCase();
          // Peso: chave de e-mail > chave de usuário > qualquer string.
          const peso = /mail/.test(nome) ? 0 : /user|usuario|login|conta/.test(nome) ? 1 : 2;
          candidatos.push({ peso, email: extrairEmail(valor), via: chave });
        } else if (valor !== null && typeof valor === 'object') {
          fila.push(valor);
        }
      }
    }
    candidatos.sort((a, b) => a.peso - b.peso);
    return candidatos[0] ?? null;
  }

  /**
   * Decodifica o payload de um JWT sem validar assinatura — não estamos
   * autenticando ninguém, só lendo quem o próprio chatPro já autenticou.
   * Devolve null pra qualquer coisa que não seja um JWT legível.
   */
  function lerJwt(valor) {
    if (typeof valor !== 'string') return null;
    const partes = valor.split('.');
    if (partes.length !== 3) return null;
    try {
      // base64url → base64, e o padding que o atob exige.
      let b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      const json = decodeURIComponent(
        atob(b64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /** As três leituras possíveis de um valor bruto, na ordem de confiança. */
  function lerValor(bruto, origem) {
    if (typeof bruto !== 'string' || bruto === '') return null;

    // 1. JSON com um campo de e-mail.
    try {
      const obj = JSON.parse(bruto);
      const achado = procurarNoObjeto(obj);
      if (achado) return { email: achado.email, via: `${origem} → ${achado.via}` };

      // 2. JSON cujo conteúdo é (ou contém) um JWT.
      const fila = [obj];
      while (fila.length > 0) {
        const atual = fila.shift();
        if (atual === null || typeof atual !== 'object') continue;
        for (const [chave, valor] of Object.entries(atual)) {
          if (typeof valor === 'string') {
            const payload = lerJwt(valor);
            const doToken = payload && procurarNoObjeto(payload);
            if (doToken) return { email: doToken.email, via: `${origem} → ${chave} (JWT)` };
          } else if (valor !== null && typeof valor === 'object') {
            fila.push(valor);
          }
        }
      }
    } catch {
      // Não era JSON — segue pros caminhos de texto puro.
    }

    // 3. O valor É um JWT.
    const payload = lerJwt(bruto);
    const doToken = payload && procurarNoObjeto(payload);
    if (doToken) return { email: doToken.email, via: `${origem} (JWT)` };

    // 4. Último recurso: um e-mail solto no texto.
    if (ehEmailUtil(bruto)) return { email: extrairEmail(bruto), via: `${origem} (texto)` };

    return null;
  }

  /** Varre um Storage inteiro, começando pela chave que sabemos o nome. */
  function procurarNoStorage(storage, nomeStorage) {
    if (!storage) return null;

    try {
      const direto = lerValor(storage.getItem(CHAVE), `${nomeStorage}['${CHAVE}']`);
      if (direto) return direto;
    } catch {
      // localStorage pode estourar em contexto restrito; não é motivo pra parar.
    }

    try {
      for (let i = 0; i < storage.length; i += 1) {
        const chave = storage.key(i);
        if (!chave || chave === CHAVE || !chave.startsWith(PREFIXO)) continue;
        const achado = lerValor(storage.getItem(chave), `${nomeStorage}['${chave}']`);
        if (achado) return achado;
      }
    } catch {
      // idem
    }
    return null;
  }

  /**
   * O DOM do menu de usuário, como último recurso. É o caminho mais frágil
   * (muda com qualquer redesenho), por isso vem por último e só procura em
   * lugares onde um e-mail de usuário faria sentido.
   */
  function procurarNoDom() {
    const seletores = [
      '[class*="user"] [class*="email"]',
      '[class*="profile"] [class*="email"]',
      '[class*="account"]',
      '[title*="@"]',
    ];
    for (const seletor of seletores) {
      let nos;
      try {
        nos = document.querySelectorAll(seletor);
      } catch {
        continue;
      }
      for (const no of nos) {
        const texto = (no.getAttribute('title') || no.textContent || '').trim();
        if (ehEmailUtil(texto)) return { email: extrairEmail(texto), via: `DOM (${seletor})` };
      }
    }
    return null;
  }

  /**
   * O e-mail do atendente, ou null. `{ email, via }` no cache pra quem quiser
   * diagnosticar sem repetir a varredura.
   */
  function detectar() {
    const agora = Date.now();
    if (cache && agora - cache.lidoEm < VALIDADE_MS) return cache;

    const achado =
      procurarNoStorage(window.localStorage, 'localStorage') ||
      procurarNoStorage(window.sessionStorage, 'sessionStorage') ||
      procurarNoDom();

    cache = { email: achado ? achado.email : null, via: achado ? achado.via : null, lidoEm: agora };
    return cache;
  }

  /** Força a próxima leitura a varrer de novo (troca de usuário, logout). */
  function esquecer() {
    cache = null;
  }

  /**
   * Diagnóstico pra quando o e-mail não aparecer: mostra QUAIS chaves existem e
   * o formato de cada uma, sem imprimir o conteúdo — os valores são tokens de
   * sessão, e token em log de console é token vazado.
   */
  function diagnosticar() {
    const linhas = [];
    for (const [nome, storage] of [
      ['localStorage', window.localStorage],
      ['sessionStorage', window.sessionStorage],
    ]) {
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const chave = storage.key(i);
          if (!chave || !chave.startsWith(PREFIXO)) continue;
          const valor = storage.getItem(chave) || '';
          let forma = 'texto';
          try {
            const obj = JSON.parse(valor);
            forma = `JSON { ${Object.keys(obj).slice(0, 12).join(', ')} }`;
          } catch {
            if (valor.split('.').length === 3) forma = 'JWT';
          }
          linhas.push(`${nome}['${chave}'] → ${forma} (${valor.length} chars)`);
        }
      } catch {
        linhas.push(`${nome}: inacessível`);
      }
    }
    return linhas;
  }

  window.__cpmAtendente = { detectar, esquecer, diagnosticar };
})();
