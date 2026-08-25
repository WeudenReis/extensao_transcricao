# Resposta — hospedagem aprovada

**Data:** 25/08/2026 · Referente ao documento de aprovação de hospedagem.

Fechado. Os cinco requisitos foram conferidos contra o código, e dois **não**
passavam — já corrigidos. Segue o que foi testado, o que mudou e o que falta.

---

## Os cinco requisitos

### 1. `HOST` e `PORT` — **estava errado, corrigido**

O app fazia `app.listen(config.port)` sem host, o que no Express significa
`0.0.0.0`. Ele teria subido escutando no IP público da VM, por fora do proxy —
exatamente o que o item existe para impedir. Passou despercebido porque em
`localhost` o sintoma não aparece.

Agora existe a variável `HOST`, e o `listen` a honra. Rodei o seu teste de
aceite:

```
$ HOST=127.0.0.1 PORT=3199 node dist/index.js
[INFO] [index] servidor ouvindo em http://127.0.0.1:3199

$ netstat -ano | grep :3199
  TCP    127.0.0.1:3199    0.0.0.0:0    LISTENING
```

`127.0.0.1`, não `0.0.0.0`. O host entrou no log de propósito: "ouvindo em
0.0.0.0" numa máquina de produção é um achado de segurança, e só dá para ver se
estiver escrito.

O padrão continua `0.0.0.0` para quem desenvolve e acessa de outro aparelho na
rede — em produção vocês passam `HOST=127.0.0.1`, que já está no `.env` que
vocês montaram.

### 2. `GET /api/health` — **já atendia, confirmado**

Responde 200 sem autenticação (está na lista de rotas liberadas do
`PANEL_TOKEN`, junto de `/webhooks/*`). Testado na instância acima:

```
$ curl http://127.0.0.1:3199/api/health
{"ok":true,"uptimeSeconds":12}     HTTP 200

$ curl http://127.0.0.1:3199/api/painel/me
HTTP 401
```

Health aberto, o resto fechado. E ele só responde depois que o `listen` abriu,
que é depois da inicialização — não há janela de "200 antes de estar pronto".

### 3. Escrever só em `/opt/extensao/data` — **atende**

O SQLite vai para o `DATABASE_PATH`. O único outro diretório que o app grava é
o de capturas, e ele é derivado do mesmo caminho:

```js
const captureDir = join(dirname(resolve(config.databasePath)), 'captures');
```

Com `DATABASE_PATH=/opt/extensao/data/app.db`, isso dá
`/opt/extensao/data/captures`. Dentro do gravável, sem precisar liberar nada.

### 4. `package-lock.json` e `better-sqlite3` arm64 — **estava velho, corrigido**

O lock já era commitado, mas a versão era `^12.2.0` — a que você mediu foi a
13.0.3. Subi para `^13.0.3`, reinstalei e rodei a suíte: **557 testes passando**,
`tsc` limpo.

### 5. CORS — **não se aplica**

Todas as chamadas saem do service worker da MV3, com `host_permissions`. Não há
nenhum `fetch` nos content scripts — conferido, zero ocorrências. Podem ignorar
o item.

---

## Sobre o `PAINEL_API_URL` por loopback

Não precisa mexer em nada. O app já valida isso do jeito certo: exige `https://`
para host remoto — o token do painel viajaria em texto claro, senão — mas abre
exceção para host local. Testei os três casos:

```
ACEITO    http://127.0.0.1:3000
ACEITO    https://painel-reunioes.chatpro.com.br
RECUSADO  http://painel-reunioes.chatpro.com.br
```

O valor de vocês passa. E a URL não está escrita à mão em lugar nenhum: sai
toda da variável de ambiente.

---

## Sobre a extensão

Pus `https://painel-reunioes.chatpro.com.br/*` no `host_permissions`. Como vocês
previram, o manifest ficou com o host do painel, que a extensão já acessava —
nenhum host novo.

**O padrão do endereço do servidor ainda aponta para `localhost`**, de propósito.
Ele vira `https://painel-reunioes.chatpro.com.br/extensao` numa versão seguinte,
depois que vocês confirmarem que o deploy subiu. Trocar antes quebraria quem usa
hoje no primeiro reload da extensão, com um 404 e nada explicando o porquê.

---

## As duas conversas abertas

**O `PANEL_TOKEN` como chave-mestra.** Você tem razão, e o argumento é mais forte
do que parece: a extensão é carregada sem compactação, então a pasta fica em
disco e o valor é legível em texto em todo navegador. Trocar por token pessoal
repassado (`cpx_…`) é o desenho certo, e a revogação individual quando alguém
sai da empresa resolve sozinha um problema que hoje não tem solução. Quero fazer.
Proponho subir com o modelo atual e tratar isso como o próximo item, não como
"algum dia" — se puderem me mandar o formato do repasse esperado, eu adapto.

**A fila de convites.** Também concordo, e o argumento que me convenceu é o da
divergência, não o do uptime: reagendamento e cancelamento feitos no painel
nunca chegam ao meu SQLite, então o convite sai para uma reunião que mudou de
hora. Isso é um bug que existe hoje e que eu não tenho como corrigir do meu lado
— só quem sabe da mudança é vocês. Se a rotina de 5 em 5 minutos que já roda
passar a cuidar disso, meu app vira repassador sem memória e o problema some por
construção. Topo sentar quando quiserem.

Nenhuma das duas bloqueia a subida.

---

## O que segue de mim

1. **Chave pública SSH** — vou gerar e mando.
2. **Valores do `.env`** — por canal privado, a lista completa. Vou incluir as
   que vocês já preencheram também, para vocês conferirem que batem.
3. **Tag:** `v3.7.0` — é a que tem as correções de `HOST` e do `better-sqlite3`.
   Publicada no GitHub, pronta para o `ssh extapp@<ip> v3.7.0`.

Sobre variável nova: combinado. Se aparecer alguma, aviso antes de publicar a
versão que depende dela.
