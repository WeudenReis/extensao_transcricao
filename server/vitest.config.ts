import { defineConfig } from 'vitest/config';

/**
 * A suíte roda com `LOG_LEVEL=warn`, e o motivo é medido:
 *
 * Com o padrão (`info`), `npx vitest run` cospe **367 mil caracteres** — e
 * 2.481 das 2.611 linhas de log são `[INFO]` da própria aplicação rodando
 * dentro dos testes ("worker iniciado", "painel reconheceu fulano", "reunião
 * criada"). Nenhuma delas diz se o teste passou; o resultado já está no
 * relatório do vitest.
 *
 * Com `warn`, a saída cai pra 55 mil — **85% menos**, com os mesmos 553 testes
 * verdes.
 *
 * Por que `warn` e não `silent`: alguns testes verificam justamente os avisos
 * (`capturarErros`/`capturarAvisos` em painel-client.test.ts espionam o
 * console pra provar que o token não vaza no log, e que o 404 de negócio NÃO
 * vira alarme de configuração). Silenciar tudo tornaria esses testes cegos —
 * eles passariam sem provar nada, que é pior do que não existirem.
 *
 * `--reporter=dot` não resolvia isso: o ruído vem do stdout da aplicação, não
 * do relatório. Trocar o reporter chegou a aumentar a saída.
 *
 * Pra depurar um teste específico, sobrescreva na hora:
 *   LOG_LEVEL=debug npx vitest run test/reunioes.test.ts
 */
export default defineConfig({
  test: {
    env: {
      LOG_LEVEL: 'warn',
    },
  },
});
