import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config';
import { REPLY_LABELS, LABELS } from '../../src/labels';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5433/db' };

describe('labels', () => {
  it('has the 4 reply labels and adds needs_review for classifiers', () => {
    expect([...REPLY_LABELS]).toEqual(['interested', 'not_interested', 'out_of_office', 'unsubscribe']);
    expect([...LABELS]).toEqual([...REPLY_LABELS, 'needs_review']);
  });
});

describe('loadConfig defaults', () => {
  it('fills every optional value when only DATABASE_URL is set', () => {
    expect(loadConfig(base)).toEqual({
      databaseUrl: 'postgres://u:p@localhost:5433/db',
      seed: 42,
      contactCount: 10000,
      simStart: new Date('2026-11-02T09:00:00Z'),
      waitDays: [3, 5, 7, 7],
      bounceRate: 0.03,
      replyRate: 0.08,
      replyMix: { interested: 0.3, not_interested: 0.35, out_of_office: 0.2, unsubscribe: 0.15 },
      oooDefaultDays: 7,
      sendBatchSize: 200,
      openrouterApiKey: null,
      openrouterModels: [],
      aiRpm: 20,
      dailyAiBudget: 45,
      delivery: {
        mailboxCount: 50,
        warmup: { start: 20, step: 10, max: 80 },
        pauseBounceRate: 0.1,
        pauseDays: 3,
        sendWindow: { startHour: 9, endHour: 17 },
        domainDailyCap: 10,
        pacing: true,
      },
    });
  });

  it('throws naming DATABASE_URL when it is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

describe('WAIT_DAYS', () => {
  it('throws naming WAIT_DAYS when there are 3 values', () => {
    expect(() => loadConfig({ ...base, WAIT_DAYS: '3,5,7' })).toThrow(/WAIT_DAYS/);
  });

  it.each(['3,0,7,7', '3,-1,7,7', '3,x,7,7', '3,1.5,7,7'])('throws on %s', (value) => {
    expect(() => loadConfig({ ...base, WAIT_DAYS: value })).toThrow(/WAIT_DAYS/);
  });

  it('accepts spaces around the values', () => {
    expect(loadConfig({ ...base, WAIT_DAYS: ' 3 , 5 ,7,7' }).waitDays).toEqual([3, 5, 7, 7]);
  });
});

describe('rates', () => {
  it('throws naming BOUNCE_RATE when it is above 1', () => {
    expect(() => loadConfig({ ...base, BOUNCE_RATE: '1.5' })).toThrow(/BOUNCE_RATE/);
  });

  it('throws naming REPLY_RATE when it is negative', () => {
    expect(() => loadConfig({ ...base, REPLY_RATE: '-0.1' })).toThrow(/REPLY_RATE/);
  });
});

describe('REPLY_MIX', () => {
  it('throws when the mix sums to 0.9', () => {
    const mix = 'interested:0.30,not_interested:0.25,out_of_office:0.20,unsubscribe:0.15';
    expect(() => loadConfig({ ...base, REPLY_MIX: mix })).toThrow(/REPLY_MIX/);
  });

  it('throws on an unknown label', () => {
    const mix = 'interested:0.30,not_interested:0.25,out_of_office:0.20,unsubscribe:0.15,maybe:0.1';
    expect(() => loadConfig({ ...base, REPLY_MIX: mix })).toThrow(/REPLY_MIX/);
  });

  it('treats a missing label as 0', () => {
    const mix = 'interested:0.5,not_interested:0.5';
    expect(loadConfig({ ...base, REPLY_MIX: mix }).replyMix).toEqual({
      interested: 0.5,
      not_interested: 0.5,
      out_of_office: 0,
      unsubscribe: 0,
    });
  });

  it('accepts a sum within 0.001 of 1', () => {
    const mix = 'interested:0.3333,not_interested:0.3333,out_of_office:0.3333';
    expect(() => loadConfig({ ...base, REPLY_MIX: mix })).not.toThrow();
  });
});

describe('OpenRouter settings', () => {
  it('turns an empty API key into null', () => {
    expect(loadConfig({ ...base, OPENROUTER_API_KEY: '' }).openrouterApiKey).toBeNull();
  });

  it('keeps a real API key', () => {
    expect(loadConfig({ ...base, OPENROUTER_API_KEY: 'sk-or-x' }).openrouterApiKey).toBe('sk-or-x');
  });

  it('splits, trims and drops empty model names', () => {
    const models = ' a/one:free , ,b/two:free,';
    expect(loadConfig({ ...base, OPENROUTER_MODELS: models }).openrouterModels).toEqual(['a/one:free', 'b/two:free']);
  });
});

describe('other checks', () => {
  it('throws naming SIM_START on an invalid date', () => {
    expect(() => loadConfig({ ...base, SIM_START: 'not-a-date' })).toThrow(/SIM_START/);
  });

  it('throws naming CONTACT_COUNT when it is 0', () => {
    expect(() => loadConfig({ ...base, CONTACT_COUNT: '0' })).toThrow(/CONTACT_COUNT/);
  });

  it('allows DAILY_AI_BUDGET of 0 (AI switched off)', () => {
    expect(loadConfig({ ...base, DAILY_AI_BUDGET: '0' }).dailyAiBudget).toBe(0);
  });

  it('throws naming SEND_BATCH_SIZE when it is 0', () => {
    expect(() => loadConfig({ ...base, SEND_BATCH_SIZE: '0' })).toThrow(/SEND_BATCH_SIZE/);
  });
});

describe('review fixes', () => {
  it.each(['1', 'Nov 2 2026', '2026-11-02', '2026-11-02T09:00:00', '2026-13-02T09:00:00Z'])(
    'throws naming SIM_START on %s (not ISO with a zone)',
    (value) => {
      expect(() => loadConfig({ ...base, SIM_START: value })).toThrow(/SIM_START/);
    },
  );

  it('reads a SIM_START offset as the same moment in UTC', () => {
    const simStart = loadConfig({ ...base, SIM_START: '2026-11-02T14:30:00+05:30' }).simStart;
    expect(simStart.toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('throws naming SEED when it is too big to hold exactly', () => {
    expect(() => loadConfig({ ...base, SEED: '99999999999999999999' })).toThrow(/SEED/);
  });

  it('uses the default when an optional value is empty or only spaces', () => {
    const config = loadConfig({ ...base, AI_RPM: '', SEND_BATCH_SIZE: '  ', WAIT_DAYS: '' });
    expect(config.aiRpm).toBe(20);
    expect(config.sendBatchSize).toBe(200);
    expect(config.waitDays).toEqual([3, 5, 7, 7]);
  });
});

// T22 (D64–D70)
describe('DELIVERABILITY and its settings', () => {
  it.each(['off', 'OFF', ' off '])('DELIVERABILITY=%j gives delivery null', (value) => {
    expect(loadConfig({ ...base, DELIVERABILITY: value }).delivery).toBeNull();
  });

  it.each(['on', 'ON', ' on ', ''])('DELIVERABILITY=%j gives delivery settings', (value) => {
    expect(loadConfig({ ...base, DELIVERABILITY: value }).delivery).not.toBeNull();
  });

  it.each(['yes', 'true', '1', 'maybe'])('DELIVERABILITY=%j throws naming DELIVERABILITY', (value) => {
    expect(() => loadConfig({ ...base, DELIVERABILITY: value })).toThrow(/DELIVERABILITY/);
  });

  it('reads every setting', () => {
    const delivery = loadConfig({
      ...base,
      MAILBOX_COUNT: '3',
      WARMUP_START: '5',
      WARMUP_STEP: '0',
      WARMUP_MAX: '5',
      PAUSE_BOUNCE_RATE: '0.2',
      PAUSE_DAYS: '1',
      SEND_WINDOW: ' 0 - 24 ',
      DOMAIN_DAILY_CAP: '1',
      SEND_PACING: ' OFF ',
    }).delivery;
    expect(delivery).toEqual({
      mailboxCount: 3,
      warmup: { start: 5, step: 0, max: 5 },
      pauseBounceRate: 0.2,
      pauseDays: 1,
      sendWindow: { startHour: 0, endHour: 24 },
      domainDailyCap: 1,
      pacing: false,
    });
  });

  it.each(['yes', '1', 'paced'])('SEND_PACING=%j throws naming SEND_PACING', (value) => {
    expect(() => loadConfig({ ...base, SEND_PACING: value })).toThrow(/SEND_PACING/);
  });

  it.each([
    ['MAILBOX_COUNT', '0'],
    ['MAILBOX_COUNT', '1001'],
    ['MAILBOX_COUNT', '2.5'],
    ['WARMUP_START', '0'],
    ['WARMUP_STEP', '-1'],
    ['WARMUP_MAX', '0'],
    ['PAUSE_BOUNCE_RATE', '1.5'],
    ['PAUSE_BOUNCE_RATE', 'x'],
    ['PAUSE_DAYS', '0'],
    ['DOMAIN_DAILY_CAP', '0'],
  ])('%s=%s throws naming the variable', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(new RegExp(name));
  });

  it('WARMUP_START above WARMUP_MAX throws naming WARMUP_START', () => {
    expect(() => loadConfig({ ...base, WARMUP_START: '90', WARMUP_MAX: '80' })).toThrow(/WARMUP_START/);
  });

  it.each(['17-9', '9-9', '9', '9-17-20', '-1-17', '9-25', 'a-b', '9.5-17'])(
    'SEND_WINDOW=%j throws naming SEND_WINDOW',
    (value) => {
      expect(() => loadConfig({ ...base, SEND_WINDOW: value })).toThrow(/SEND_WINDOW/);
    },
  );

  it('still validates the settings when DELIVERABILITY is off', () => {
    expect(() => loadConfig({ ...base, DELIVERABILITY: 'off', SEND_WINDOW: '17-9' })).toThrow(/SEND_WINDOW/);
  });
});
