import { Injectable, UnauthorizedException } from '@nestjs/common';
import { argon2, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';

type Admin = { id: string; organizationId: string; email: string; passwordHash: string; name: string; role: string; isActive: boolean; lockedUntil: Date | null; failedLogins: number };
type Session = { sub: string; exp: number; nonce: string };
const failures = 5;
const lockMs = 15 * 60 * 1000;

function verifyPassword(hash: string, password: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6 || !['argon2id', 'argon2i', 'argon2d'].includes(parts[1]) || parts[2] !== 'v=19') return Promise.resolve(false);
  const params = Object.fromEntries(parts[3].split(',').map(part => part.split('=')));
  const memory = Number(params.m), passes = Number(params.t), parallelism = Number(params.p);
  if (!Number.isInteger(memory) || memory < 64 || memory > 1048576 || !Number.isInteger(passes) || passes < 1 || passes > 20 || !Number.isInteger(parallelism) || parallelism < 1 || parallelism > 64) return Promise.resolve(false);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || expected.length < 16) return Promise.resolve(false);
  return new Promise(resolve => {
    argon2(parts[1] as 'argon2id' | 'argon2i' | 'argon2d', { message: password, nonce: salt, parallelism, tagLength: expected.length, memory, passes }, (error, actual) => {
      resolve(!error && actual.length === expected.length && timingSafeEqual(actual, expected));
    });
  });
}

@Injectable()
export class AuthService {
  private revoked = new Map<string, number>();
  constructor(private database: DatabaseService) {}

  private secret(): string {
    const secret = process.env.AUTH_SECRET || process.env.DATABASE_URL;
    if (!secret) throw new Error('AUTH_SECRET veya DATABASE_URL gerekli.');
    return secret;
  }

  private sign(body: string) { return createHmac('sha256', this.secret()).update(body).digest('base64url'); }

  async login(email: string, password: string) {
    if (!email || !password) throw new UnauthorizedException('Geçersiz e-posta veya parola.');
    const rows = await this.database.query<Admin>('SELECT id,"organizationId",email,"passwordHash",name,role,"isActive","lockedUntil","failedLogins" FROM "AdminUser" WHERE lower(email)=lower($1) LIMIT 1', [email.trim()]);
    const user = rows[0];
    if (!user) throw new UnauthorizedException('Geçersiz e-posta veya parola.');
    if (!user.isActive) throw new UnauthorizedException('Hesap pasif.');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new UnauthorizedException('Hesap geçici olarak kilitli.');
    if (!(await verifyPassword(user.passwordHash, password))) {
      const failed = user.failedLogins + 1;
      await this.database.query('UPDATE "AdminUser" SET "failedLogins"=$2,"lockedUntil"=$3 WHERE id=$1', [user.id, failed, failed >= failures ? new Date(Date.now() + lockMs) : null]);
      throw new UnauthorizedException('Geçersiz e-posta veya parola.');
    }
    await this.database.query('UPDATE "AdminUser" SET "failedLogins"=0,"lockedUntil"=NULL WHERE id=$1', [user.id]);
    const payload: Session = { sub: user.id, exp: Date.now() + 12 * 60 * 60 * 1000, nonce: randomUUID() };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, user: { id: user.id, email: user.email, name: user.name, role: user.role, organizationId: user.organizationId } };
  }

  async verify(token: string) {
    const [body, signature] = token.split('.');
    if (!body || !signature) throw new UnauthorizedException();
    const expected = this.sign(body);
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    let session: Session;
    try { session = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session; } catch { throw new UnauthorizedException(); }
    if (!session.sub || !session.nonce || session.exp <= Date.now() || this.revoked.has(session.nonce)) throw new UnauthorizedException();
    const rows = await this.database.query<{ id: string; organizationId: string; email: string; name: string; role: string }>('SELECT id,"organizationId",email,name,role FROM "AdminUser" WHERE id=$1 AND "isActive"=true', [session.sub]);
    if (!rows.length) throw new UnauthorizedException();
    return { session, user: rows[0] };
  }

  logout(session: Session) {
    this.revoked.set(session.nonce, session.exp);
    for (const [nonce, exp] of this.revoked) if (exp <= Date.now()) this.revoked.delete(nonce);
    return { ok: true };
  }
}
