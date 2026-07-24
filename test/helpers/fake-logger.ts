import type { FastifyBaseLogger } from 'fastify';

export interface CapturedLogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg?: string;
}

// Minimal FastifyBaseLogger stand-in that records every call so tests can
// assert on structured-log field shape (and, for leakage tests, that a
// sentinel string never appears anywhere in the captured output).
export function createFakeLogger(): FastifyBaseLogger & { calls: CapturedLogCall[] } {
  const calls: CapturedLogCall[] = [];
  function record(level: CapturedLogCall['level']) {
    return (fieldsOrMsg: unknown, msg?: string) => {
      if (typeof fieldsOrMsg === 'string') {
        calls.push({ level, fields: {}, msg: fieldsOrMsg });
      } else {
        calls.push({ level, fields: (fieldsOrMsg ?? {}) as Record<string, unknown>, msg });
      }
    };
  }
  const logger = {
    calls,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('error'),
    trace: record('debug'),
    silent: () => {},
    level: 'debug',
    child: () => createFakeLogger(),
  };
  return logger as unknown as FastifyBaseLogger & { calls: CapturedLogCall[] };
}
