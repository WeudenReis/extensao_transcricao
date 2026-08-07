# chatPro Reuniões — extensão

Põe um botão **reunião** na barra de atendimento do chatPro. Um
clique faz tudo:

1. cria o link do Meet na **sua** agenda do Google
2. envia o link pro cliente na conversa
3. coloca o bot de gravação na sala
4. abre a reunião numa aba nova

Quando a chamada acaba, a transcrição volta sozinha como **comentário** naquela
mesma conversa.

## Instalar

1. Baixe/extraia esta pasta
2. `chrome://extensions` → ative o **Modo do desenvolvedor**
3. **Carregar sem compactação** → escolha a pasta `extension/`

## Configurar (uma vez por pessoa)

Abra a extensão pelo ícone:

1. **Servidor** — endereço do backend e a chave do painel (`PANEL_TOKEN`)
2. **Salvar**
3. **Conectar conta Google** — abre o consent; ao voltar, aparece
   "Conectado: seu@email"

A conta Google é sua e serve pra criar o link. Funciona com **conta pessoal
@gmail** — não precisa de Workspace.

> O que fica guardado no seu navegador é só o endereço do servidor, a chave do
> painel e um identificador da instalação. O acesso à sua conta Google fica
> cifrado no servidor, nunca na extensão.

## Usar

Abra uma conversa no chatPro. O botão aparece na barra de cima, ao lado de
"transferir". Clique quando quiser levar o atendimento pra uma chamada.

## Como o botão se adapta ao tema

O chatPro não expõe classes estáveis, então o botão **clona** um dos botões que
já estão na barra e troca só o ícone e o texto. Assim ele herda fonte,
espaçamento, hover e as cores dos temas claro e escuro — e continua certo se o
chatPro mudar o CSS.

Se algum dia o botão sumir ou ficar torto, é sinal de que o layout deles mudou:
o seletor está em `content/botao-reuniao.js`, na constante `VIZINHOS`.

## Arquivos

```
manifest.json                 MV3, roda só em app.chatpro.com.br
content/botao-reuniao.js      acha a barra, clona o botão, injeta
background/service-worker.js  ponte com o backend (estado em chrome.storage)
popup/                        conta Google + endereço do servidor
```
