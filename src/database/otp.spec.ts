import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service.js';

function serviceWithAttempt(attempts: number, inviteExpiresAt = new Date(Date.now() + 60000)) {
  const service = Object.create(DatabaseService.prototype) as DatabaseService;
  const codeHash = createHmac('sha256', process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me-32-chars-min')
    .update('salt:123456').digest('hex');
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM "Invite" i JOIN')) return { rows: [{ id: 'invite-1', status: 'OPENED', expiresAt: inviteExpiresAt, organizationId: 'org', candidateName: 'Ada', candidateEmail: 'ada@example.com' }] };
    if (sql.includes('FROM "EmailVerificationAttempt"') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'attempt-1', codeHash: `salt.${codeHash}`, expiresAt: new Date(Date.now() + 60000), attempts }] };
    return { rows: [] };
  });
  Reflect.set(service, 'client', { query });
  Reflect.set(service, 'queryQueue', Promise.resolve());
  return { service, statements };
}

describe('evaluation email verification', () => {
  it('commits a wrong-code attempt before returning the error', async () => {
    const { service, statements } = serviceWithAttempt(0);
    await expect(service.verifyEvaluationEmailCode('a'.repeat(43), '000000')).rejects.toThrow('Kod hatalı');
    expect(statements.some(sql => sql.includes('SET attempts=attempts+1'))).toBe(true);
    expect(statements).toContain('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
  });

  it('consumes the code and verifies the invitation after a correct code', async () => {
    const { service, statements } = serviceWithAttempt(0);
    await expect(service.verifyEvaluationEmailCode('a'.repeat(43), '123456')).resolves.toEqual({ ok: true });
    expect(statements.some(sql => sql.includes('SET "consumedAt"=NOW()'))).toBe(true);
    expect(statements.some(sql => sql.includes("status='EMAIL_VERIFIED'"))).toBe(true);
  });

  it('blocks the sixth attempt', async () => {
    const { service, statements } = serviceWithAttempt(5);
    await expect(service.verifyEvaluationEmailCode('a'.repeat(43), '123456')).rejects.toThrow('Çok fazla yanlış deneme');
    expect(statements.some(sql => sql.includes('SET attempts=attempts+1'))).toBe(false);
  });

  it('rejects verification after the invitation expires', async () => {
    const { service, statements } = serviceWithAttempt(0, new Date(Date.now() - 1000));
    await expect(service.verifyEvaluationEmailCode('a'.repeat(43), '123456')).rejects.toThrow('artık geçerli değil');
    expect(statements.some(sql => sql.includes("status='EMAIL_VERIFIED'"))).toBe(false);
  });
});
