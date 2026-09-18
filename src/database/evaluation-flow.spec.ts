import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service.js';

const token = 'a'.repeat(43);
function createService(status: string) {
  const statements: string[] = [];
  const service = Object.create(DatabaseService.prototype) as DatabaseService;
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM "Invite" i JOIN')) return { rows: [{ id: 'invite', status, expiresAt: new Date(Date.now() + 60000), organizationId: 'org', templateId: 'template', candidateName: 'Ada', candidateEmail: 'ada@example.com', durationSec: 1200 }] };
    if (sql.includes('FROM "ConsentDocument"') && sql.includes('SELECT id')) return { rows: [{ id: 'document' }] };
    if (sql.includes('FROM "CandidateSession" WHERE "inviteId"')) return { rows: [] };
    if (sql.includes('INSERT INTO "CandidateSession"')) return { rows: [{ id: 'session', stage: 'ASSESSMENT', startedAt: new Date(), inviteId: 'invite' }] };
    return { rows: [] };
  });
  Reflect.set(service, 'client', { query });
  Reflect.set(service, 'queryQueue', Promise.resolve());
  return { service, statements, query };
}

describe('candidate evaluation flow', () => {
  it('accepts every active consent and then changes invite status', async () => {
    const { service, statements } = createService('EMAIL_VERIFIED');
    await expect(service.acceptEvaluationConsents(token, ['document'])).resolves.toEqual({ ok: true });
    expect(statements.some(sql => sql.includes('INSERT INTO "CandidateConsent"'))).toBe(true);
    expect(statements.some(sql => sql.includes("status='CONSENT_ACCEPTED'"))).toBe(true);
    expect(statements).toContain('COMMIT');
  });

  it('rejects consent without email verification', async () => {
    const { service, statements } = createService('OPENED');
    await expect(service.acceptEvaluationConsents(token, ['document'])).rejects.toThrow('Önce e-posta');
    expect(statements.some(sql => sql.includes('INSERT INTO "CandidateConsent"'))).toBe(false);
  });

  it('creates a session only after consent', async () => {
    const { service, statements } = createService('CONSENT_ACCEPTED');
    const session = await service.startEvaluationSession(token, { fullscreenAtStart: false });
    expect(session.sessionId).toBe('session');
    expect(statements.some(sql => sql.includes('INSERT INTO "CandidateSession"'))).toBe(true);
    expect(statements.some(sql => sql.includes("status='IN_PROGRESS'"))).toBe(true);
  });
});
