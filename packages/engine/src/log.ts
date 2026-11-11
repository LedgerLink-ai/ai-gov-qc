import { randomUUID } from 'node:crypto';
import { redact, redactDeep } from './redact';
import { ENGINE_VERSION } from './version';

/**
 * Structured logging. Every event is one JSON object per line on stderr when
 * QA_LOG_FORMAT=json (or --log-format json); in text form only warnings and
 * errors are shown, as "qa: ...", so the git hooks stay quiet. Every line
 * carries the engine version and a run id, and is redacted.
 *
 *   QA_LOG_FORMAT   text | json          (default text)
 *   QA_LOG_LEVEL    debug | info | warn | error | silent   (default warn; info for json)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

const ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface LogSettings {
  format: LogFormat;
  level: LogLevel | 'silent';
}

export interface Logger {
  readonly runId: string;
  readonly settings: LogSettings;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>, text?: string): void;
  error(event: string, fields?: Record<string, unknown>, text?: string): void;
}

export function parseLogSettings(format?: string, level?: string): LogSettings {
  const f = (format ?? process.env.QA_LOG_FORMAT ?? 'text').toLowerCase();
  if (f !== 'text' && f !== 'json') throw new Error(`log format must be text or json, got "${f}"`);
  const l = (level ?? process.env.QA_LOG_LEVEL ?? (f === 'json' ? 'info' : 'warn')).toLowerCase();
  if (!(l in ORDER)) throw new Error(`log level must be one of ${Object.keys(ORDER).join(', ')}, got "${l}"`);
  return { format: f, level: l as LogLevel | 'silent' };
}

export function createLogger(
  settings: LogSettings = parseLogSettings(),
  write: (line: string) => void = (line) => process.stderr.write(line),
  runId: string = randomUUID(),
): Logger {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}, text?: string): void => {
    if (ORDER[level] < ORDER[settings.level]) return;
    if (settings.format === 'json') {
      const record = {
        ts: new Date().toISOString(),
        level,
        event,
        engine_version: ENGINE_VERSION,
        run_id: runId,
        ...redactDeep(fields),
      };
      write(`${JSON.stringify(record)}\n`);
    } else if (text !== undefined || ORDER[level] >= ORDER.warn) {
      const detail = text ?? `${event}${Object.keys(fields).length ? ` ${JSON.stringify(redactDeep(fields))}` : ''}`;
      write(`qa: ${redact(detail)}\n`);
    }
  };
  return {
    runId,
    settings,
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f, t) => emit('warn', e, f, t),
    error: (e, f, t) => emit('error', e, f, t),
  };
}

let current: Logger | undefined;

/** The process-wide logger, configured once by the CLI. */
export function logger(): Logger {
  current ??= createLogger(safeSettings());
  return current;
}

export function setLogger(l: Logger): void {
  current = l;
}

function safeSettings(): LogSettings {
  try {
    return parseLogSettings();
  } catch {
    return { format: 'text', level: 'warn' };
  }
}
