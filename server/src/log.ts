/**
 * Logger simples com prefixo de módulo e níveis.
 *
 * REGRA DE OURO: nunca logar transcript inteiro nem tokens.
 * Logue contagem de entries, nomes de recursos e status — nunca conteúdo.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

let minLevel: LogLevel = isLogLevel(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function write(level: LogLevel, module: string, message: string): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${module}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(module: string): Logger {
  return {
    debug: (message) => write('debug', module, message),
    info: (message) => write('info', module, message),
    warn: (message) => write('warn', module, message),
    error: (message, err) =>
      write('error', module, err === undefined ? message : `${message} — ${errorMessage(err)}`),
  };
}
