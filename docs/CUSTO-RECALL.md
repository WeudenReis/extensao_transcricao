# Quanto custa gravar as reuniões do time comercial

> Levantado em 13/08/2026, direto do site do Recall e da nossa própria conta.

## A resposta curta

**Não existe plano gratuito mensal no Recall.** O que existe é um crédito de
**5 horas, uma vez só**, que não renova. Depois disso é pós-pago por hora.

Nossa conta **já usou 0,77h** das 5h nos testes deste projeto (9 reuniões
gravadas de fato). Sobram ~4,2h.

Com 5 atendentes marcando 3 reuniões por dia, esse crédito acaba **no terceiro
dia de uso real**.

## A tabela de preços

| Item | Preço |
|---|---|
| Gravação | US$ 0,50 por hora de reunião |
| Transcrição embutida | US$ 0,15 por hora |
| **Total por hora de reunião** | **US$ 0,65** |
| Armazenamento | grátis por 7 dias; US$ 0,05/h a cada 30 dias depois |
| Taxa de plataforma | nenhuma |
| Mensalidade mínima | nenhuma |
| Limite de bots simultâneos | **não há** |

Cobra-se pela duração da reunião, não por participante.

## Projeção para o time comercial

Considerando reuniões de 45 minutos e 21 dias úteis:

| Time | Horas/mês | US$/mês | R$/mês (câmbio 5,4) |
|---|---|---|---|
| 5 atendentes × 3 reuniões/dia | 236h | 154 | 829 |
| 8 atendentes × 4 reuniões/dia | 504h | 328 | 1.769 |
| 12 atendentes × 5 reuniões/dia | 945h | 614 | 3.317 |

## Como reduzir

1. **Programa de startup do Recall** — derruba para **US$ 0,25/h nas primeiras
   10.000 horas**. Corta a conta pela metade. Vale pedir *antes* de liberar
   para o time; é o item de maior impacto desta lista.
2. **Cortar a transcrição do Recall (US$ 0,15/h)** — economiza ~23%. O projeto
   já tem o resumo extrativo e o motor de palavras-chave rodando **sem IA**,
   mas os dois leem o texto que o Recall entrega. Trocar exigiria transcrever
   por fora, o que reintroduz o Whisper que a gente desligou de propósito.
   Só compensa em volume alto.
3. **Não gravar tudo** — reunião de apresentação costuma ser a que mais rende
   informação comercial; implantação e CS são mais operacionais. Gravar por
   tipo é uma chave que o fluxo novo já suporta (o `tipo` está no banco).
4. **`automatic_leave`** já está configurado: o bot sai sozinho quando a sala
   esvazia, então reunião esquecida aberta não vira fatura.

## O gasto invisível: bot que não grava

Das 17 reuniões criadas na conta até agora, **8 nunca gravaram** — o bot ficou
preso na sala de espera esperando alguém admitir. Isso não gera custo de
gravação, mas gera uma reunião perdida.

A correção é usar um **bot autenticado** (conta Google dedicada com acesso à
organização), que entra direto sem depender de admissão manual. Enquanto isso
não existe, o alerta de "reunião não gravada" avisa na conversa.
