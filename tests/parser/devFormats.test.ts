import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { isLogfmtLine, parseGoDuration, splitLogfmt } from '../../src/parser/logfmt';

const read = (name: string) => readFileSync(`fixtures/${name}`, 'utf8');
const roleOf = (r: ReturnType<typeof parseText>, role: string) => r.schema.find((c) => c.role === role)?.key;
const errorMessages = (r: ReturnType<typeof parseText>) => {
  const index = buildLogIndex(r.rows, r.schema);
  const msg = roleOf(r, 'message')!;
  return r.rows.filter((_, i) => isErrorRow(index, i)).map((x) => String(x.values[msg]).split('\n')[0]);
};

describe('detectFormat for common developer logs', () => {
  it.each([
    ['sample-python.log', 'generic'],
    ['sample-logback.log', 'generic'],
    ['sample-springboot.log', 'generic'],
    ['sample-nginx-error.log', 'generic'],
    ['sample-pino.log', 'jsonl'],
    ['sample-docker.log', 'jsonl'],
    ['sample-logfmt.log', 'logfmt'],
  ])('%s → %s', (file, expected) => {
    expect(detectFormat(splitLines(read(file)))).toBe(expected);
  });
});

describe('Python logging', () => {
  const r = parseText(read('sample-python.log'));

  it('takes logger and level from "time - name - LEVEL - message"', () => {
    expect(r.rows).toHaveLength(4);
    expect(r.malformed).toHaveLength(0);
    expect(r.rows[2]!.values).toMatchObject({ level: 'ERROR', logger: 'app.db', message: expect.stringMatching(/^Connection lost/) });
    expect(r.rows[1]!.values.level).toBe('WARN');
  });

  it('keeps the traceback on its entry and counts it as an error', () => {
    expect(String(r.rows[2]!.values.message).split('\n')).toHaveLength(4);
    expect(errorMessages(r)).toEqual(['Connection lost to db01:5432']);
  });
});

describe('logback / log4j', () => {
  it('reads "[thread] LEVEL logger - message"', () => {
    const r = parseText(read('sample-logback.log'));
    expect(r.rows).toHaveLength(4);
    expect(r.rows[2]!.values).toMatchObject({
      level: 'ERROR',
      thread: 'http-nio-8080-exec-7',
      logger: 'com.acme.orders.PaymentClient',
      message: expect.stringMatching(/^Payment declined for order 1002\njava.lang.IllegalStateException/),
    });
    expect(r.schema.map((c) => c.key)).toEqual(['timestamp', 'level', 'logger', 'thread', 'message']);
    expect(errorMessages(r)).toEqual(['Payment declined for order 1002']);
  });

  it('reads log4j\'s "LEVEL [thread] logger - message"', () => {
    const r = parseText('2026-10-27 04:42:03,120 ERROR [main] com.acme.Svc - boom\n');
    expect(r.rows[0]!.values).toMatchObject({ level: 'ERROR', thread: 'main', logger: 'com.acme.Svc', message: 'boom' });
  });

  it('leaves bracketed loggers without a dotted name alone (Serilog-style)', () => {
    const r = parseText('2026-10-27 04:42:02.120 INFO  [Startup] Application starting - phase 1\n');
    expect(r.rows[0]!.values).toMatchObject({ level: 'INFO', logger: 'Startup', message: 'Application starting - phase 1' });
    expect(r.schema.some((c) => c.key === 'thread')).toBe(false);
  });
});

describe('Spring Boot', () => {
  it('reads pid, thread and logger', () => {
    const r = parseText(read('sample-springboot.log'));
    expect(r.rows).toHaveLength(3);
    expect(r.rows[1]!.values).toMatchObject({
      level: 'WARN',
      pid: 4312,
      thread: 'nio-8080-exec-1',
      logger: 'c.a.orders.web.OrderController',
      message: 'Order 1001 has no address',
    });
    expect(r.rows[2]!.values.logger).toBe('o.a.c.c.C.[.[.[/].[dispatcherServlet]');
  });

  it('reads Spring Boot 2 lines (no application name)', () => {
    const r = parseText('2026-10-27 04:42:03.120  INFO 1234 --- [           main] c.a.App                : Started\n');
    expect(r.rows[0]!.values).toMatchObject({ level: 'INFO', pid: 1234, thread: 'main', logger: 'c.a.App', message: 'Started' });
  });
});

describe('Nginx error log', () => {
  const r = parseText(read('sample-nginx-error.log'));

  it('reads the slash date, level, client, request and host', () => {
    expect(r.rows).toHaveLength(4);
    expect(r.malformed).toHaveLength(0);
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 2));
    expect(r.rows[2]!.values).toMatchObject({
      level: 'ERROR',
      pid: 23,
      client: '198.51.100.20',
      RequestMethod: 'POST',
      RequestPath: '/api/orders',
      host: 'shop.example.com',
      message: expect.stringMatching(/^upstream timed out/),
    });
    expect(r.rows[0]!.values.level).toBe('NOTICE');
    expect(roleOf(r, 'clientIp')).toBe('client');
    expect(roleOf(r, 'uri')).toBe('RequestPath');
  });

  it('counts error and crit lines as errors', () => {
    expect(errorMessages(r)).toHaveLength(2);
  });
});

describe('pino / bunyan JSON', () => {
  const r = parseText(read('sample-pino.log'));

  it('turns numeric levels into names', () => {
    expect(r.rows.map((x) => x.values.level)).toEqual(['INFO', 'INFO', 'ERROR', 'WARN']);
    expect(errorMessages(r)).toEqual(['request errored']);
  });

  it('flattens req/res so method, URL, status, duration and client IP get their roles', () => {
    expect(r.rows[2]!.values).toMatchObject({ 'req.method': 'POST', 'req.url': '/api/orders', 'res.statusCode': 500, responseTime: 431 });
    expect(roleOf(r, 'method')).toBe('req.method');
    expect(roleOf(r, 'uri')).toBe('req.url');
    expect(roleOf(r, 'status')).toBe('res.statusCode');
    expect(roleOf(r, 'duration')).toBe('responseTime');
    expect(roleOf(r, 'clientIp')).toBe('req.remoteAddress');
  });
});

describe('Docker json-file logs', () => {
  const r = parseText(read('sample-docker.log'));

  it('reads the container output as the message, with level and stream', () => {
    expect(r.rows).toHaveLength(4);
    expect(r.malformed).toHaveLength(0);
    expect(r.rows[0]!.values).toMatchObject({ stream: 'stdout', level: 'INFO', logger: 'Startup', message: 'Listening on :8080' });
    expect(r.rows[2]!.values).toMatchObject({ level: 'WARN', message: 'cache miss ratio high' });
    expect(r.rows[3]!.values).toMatchObject({ message: 'plain text from the container' });
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 2, 120));
    expect(roleOf(r, 'message')).toBe('message');
    expect(r.schema.some((c) => c.key === 'log')).toBe(false);
  });

  it('spreads JSON output from the container into columns', () => {
    expect(r.rows[1]!.values).toMatchObject({ stream: 'stderr', level: 'error', msg: 'db timeout', path: '/api/orders', status: 500 });
  });
});

describe('structlog JSON', () => {
  it('uses "event" as the message when there is no message field', () => {
    const r = parseText('{"event":"user logged in","level":"info","timestamp":"2026-10-27T04:42:02Z","user":7}\n');
    expect(roleOf(r, 'message')).toBe('event');
  });
});

describe('logfmt', () => {
  const r = parseText(read('sample-logfmt.log'));

  it('parses key=value pairs with quoting and escapes', () => {
    expect(r.format).toBe('logfmt');
    expect(r.rows).toHaveLength(4);
    expect(r.malformed).toHaveLength(0);
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 2, 120));
    expect(r.rows[3]!.values.query).toBe('SELECT * FROM "orders"');
    expect(r.rows[2]!.values).toMatchObject({ level: 'ERROR', status: 500, err: 'context deadline exceeded' });
  });

  it('converts Go durations to milliseconds and keeps ids with leading zeros as text', () => {
    expect(r.rows[1]!.values.duration).toBe(12.5);
    expect(r.rows[2]!.values.duration).toBe(1200);
    expect(r.rows[3]!.values.took).toBe(850);
    expect(r.rows[2]!.values.user).toBe('007');
    expect(r.schema.find((c) => c.key === 'duration')).toMatchObject({ label: 'duration (ms)', type: 'number', role: 'duration' });
  });

  it('gives roles to well-known keys and appends stack traces to the previous entry', () => {
    expect(roleOf(r, 'level')).toBe('level');
    expect(roleOf(r, 'message')).toBe('msg');
    expect(roleOf(r, 'uri')).toBe('path');
    expect(roleOf(r, 'status')).toBe('status');
    expect(String(r.rows[2]!.values.msg).split('\n')).toEqual(['request failed', 'goroutine 18 [running]:', 'main.handler(0xc000123456)']);
    expect(errorMessages(r)).toEqual(['request failed']);
  });

  it('splits lines and recognises logfmt', () => {
    expect(splitLogfmt('a=1 b="x y" flag c=')).toEqual([['a', '1'], ['b', 'x y'], ['flag', true], ['c', '']]);
    expect(splitLogfmt('a="unclosed')).toBeNull();
    expect(isLogfmtLine('level=info msg=hi a=1')).toBe(true);
    expect(isLogfmtLine('level=info hello world how are you')).toBe(false);
    expect(isLogfmtLine('2026-10-27 INFO user=1 a=2 b=3')).toBe(false);
    expect(isLogfmtLine('{"a":1}')).toBe(false);
  });

  it('parses Go durations', () => {
    expect(parseGoDuration('1m2.5s')).toBe(62_500);
    expect(parseGoDuration('350µs')).toBe(0.35);
    expect(parseGoDuration('12')).toBeNull();
    expect(parseGoDuration('fast')).toBeNull();
  });
});
