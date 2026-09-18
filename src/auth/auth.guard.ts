import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';

export type AdminRequest = Request & { admin?: { id: string; organizationId: string; email: string; name: string; role: string }; authSession?: { sub: string; exp: number; nonce: string } };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    if (req.path === '/auth/login' && req.method === 'POST') return true;
    if ((req.method === 'GET' && /^\/appointments\/[A-Za-z0-9_-]{32}$/.test(req.path)) ||
        (req.method === 'POST' && /^\/appointments\/[A-Za-z0-9_-]{32}\/book$/.test(req.path))) return true;
    if ((req.method === 'GET' && /^\/candidate\/invites\/[A-Za-z0-9_-]{43}$/.test(req.path)) ||
        (req.method === 'POST' && /^\/candidate\/invites\/[A-Za-z0-9_-]{43}\/(?:send-email-code|verify-email-code|accept-consent|start)$/.test(req.path))) return true;
    if (req.method === 'POST' && /^\/candidate\/sessions\/[A-Za-z0-9_-]{20,40}\/(?:answer|submit|proctor-event|heartbeat)$/.test(req.path)) return true;
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!match) throw new UnauthorizedException();
    const result = await this.auth.verify(match[1]);
    req.admin = result.user;
    req.authSession = result.session;
    return true;
  }
}
