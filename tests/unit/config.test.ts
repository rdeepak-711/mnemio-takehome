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
    expect(loadConfig({ ...base, OPENROUTER_MODELS: models }).openrouterModels).toEqual([
      'a/one:free',
      'b/two:free',
    ]);
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
