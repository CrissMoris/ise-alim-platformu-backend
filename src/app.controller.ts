import { BadRequestException, Controller, Get, Param, Patch, Body, Post, Delete, Req } from '@nestjs/common';
import { AppService } from './app.service.js';
import { DatabaseService } from './database/database.service.js';
import { AuthService } from './auth/auth.service.js';
import type { AdminRequest } from './auth/auth.guard.js';
import { EmailService } from './email/email.service.js';
import { renderInviteMail } from './email/invite-template.js';
import { renderOtpMail } from './email/otp-template.js';
import type { AnswerValue } from './scoring/assessment-scoring.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly databaseService: DatabaseService,
    private readonly authService: AuthService,
    private readonly emailService: EmailService,
  ) {}

  @Post('auth/login')
  login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body?.email, body?.password);
  }

  @Get('auth/me')
  me(@Req() req: AdminRequest) { return req.admin; }

  @Post('auth/logout')
  logout(@Req() req: AdminRequest) { return this.authService.logout(req.authSession!); }

  @Get('candidates/:id')
  async getCandidateById(@Param('id') id: string) {
    return this.databaseService.getCandidateById(id);
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('db-test')
  async testDatabase() {
    return this.databaseService.testConnection();
  }

  @Get('positions')
  async getPositions() {
    return this.databaseService.getPositions();
  }

  @Get('candidates')
  async getCandidates() {
    return this.databaseService.getCandidates();
  }

  @Get('positions/:id/candidates')
  async getCandidatesByPosition(@Param('id') id: string) {
    return this.databaseService.getCandidatesByPosition(id);
  }

  @Get('dashboard/stats')
  async getDashboardStats() {
    return this.databaseService.getDashboardStats();
  }

  @Get('questions')
  async getQuestions() {
    return this.databaseService.getQuestions();
  }

  @Get('technical/questions')
  async getTechnicalQuestions() {
    return this.databaseService.getTechnicalQuestions();
  }

  @Get('technical/sessions')
  async getTechnicalSessions() {
    return this.databaseService.getTechnicalSessions();
  }

  @Post('technical/sessions')
  async createTechnicalSession(
    @Req() req: AdminRequest,
    @Body() body: { candidateId: string; questionIds: string[] },
  ) {
    return this.databaseService.createTechnicalSession(body, req.admin!.id, req.admin!.organizationId);
  }

  @Get('technical/sessions/:id')
  async getTechnicalSession(@Param('id') id: string) {
    return this.databaseService.getTechnicalSession(id);
  }

  @Post('technical/sessions/:id/start')
  async startTechnicalSession(@Param('id') id: string) {
    return this.databaseService.startTechnicalSession(id);
  }

  @Post('technical/sessions/:id/submit')
  async submitTechnicalSession(
    @Param('id') id: string,
    @Body() body: { questionId: string; language: string; code: string; explanation?: string },
  ) {
    return this.databaseService.submitTechnicalSession(id, body);
  }

  @Post('technical/sessions/:id/evaluate')
  async evaluateTechnicalSession(
    @Param('id') id: string,
    @Body() body: {
      rubric: Array<{ questionId: string; scores: Record<string, number>; comment?: string }>;
      reviewerOverallScore?: number | null;
      reviewerNote?: string | null;
    },
  ) {
    return this.databaseService.evaluateTechnicalSession(id, body);
  }

  @Get('invites')
  async getInvites() {
    return this.databaseService.getInvites();
  }

  @Post('invites')
  async createEvaluationInvite(@Req() req: AdminRequest, @Body() body: { candidateId: string }) {
    const base = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000')
      .split(',')[0]?.trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\//i.test(base)) {
      throw new BadRequestException('WEB_PUBLIC_URL geçerli bir web adresi olmalı.');
    }
    const invite = await this.databaseService.createEvaluationInvite(body?.candidateId, req.admin!.organizationId, req.admin!.id);
    if (invite.reused) return { reused: true, status: invite.status, mail: { sent: false, reason: 'existing-invite' } };
    const url = new URL(`/invite/${encodeURIComponent(invite.token)}`, base).toString();
    const companyName = process.env.COMPANY_NAME ?? 'ECR Etkinlik Bilgisayar';
    const expiry = invite.expiresAt.toLocaleString('tr-TR');
    const { subject, html, text } = renderInviteMail({
      candidateName: invite.candidate.fullName,
      companyName,
      inviteUrl: url,
      expiresAtHuman: expiry,
      webUrl: base,
      sourceNoteHtml: '',
      sourceNoteText: '',
    }, escapeHtml);
    const mail = await this.emailService.sendRaw(invite.candidate.email, subject, html, text);
    if (mail.sent) await this.databaseService.markEvaluationInviteSent(invite.id);
    else await this.databaseService.discardUnsentEvaluationInvite(invite.id);
    return { reused: false, mail };
  }

  @Get('candidate/invites/:token')
  resolveEvaluationInvite(@Param('token') token: string) {
    return this.databaseService.resolveEvaluationInvite(token);
  }

  @Post('candidate/invites/:token/send-email-code')
  async sendEvaluationEmailCode(@Param('token') token: string) {
    const attempt = await this.databaseService.createEvaluationEmailCode(token);
    const webUrl = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000').split(',')[0]?.trim().replace(/\/+$/, '') ?? '';
    const { subject, html, text } = renderOtpMail(
      attempt.candidateName, attempt.code, webUrl, process.env.COMPANY_NAME ?? 'ECR Etkinlik Bilgisayar', escapeHtml,
    );
    const mail = await this.emailService.sendRaw(attempt.candidateEmail, subject, html, text);
    if (!mail.sent) {
      await this.databaseService.discardEvaluationEmailCode(attempt.attemptId);
      throw new BadRequestException(mail.error ?? 'Doğrulama kodu gönderilemedi.');
    }
    return { ok: true, sentTo: attempt.sentTo, ttlMs: attempt.ttlMs };
  }

  @Post('candidate/invites/:token/verify-email-code')
  verifyEvaluationEmailCode(@Param('token') token: string, @Body() body: { code: string }) {
    return this.databaseService.verifyEvaluationEmailCode(token, body?.code);
  }

  @Post('candidate/invites/:token/accept-consent')
  acceptEvaluationConsents(
    @Param('token') token: string,
    @Body() body: { consents: Array<{ documentId: string; accepted: boolean }> },
    @Req() req: AdminRequest,
  ) {
    if (!Array.isArray(body?.consents) || body.consents.some(consent => consent?.accepted !== true)) {
      throw new BadRequestException('Onay metinlerini kabul edin.');
    }
    return this.databaseService.acceptEvaluationConsents(
      token, body.consents.map(consent => consent.documentId), req.ip, req.headers['user-agent'],
    );
  }

  @Post('candidate/invites/:token/start')
  startEvaluationSession(
    @Param('token') token: string,
    @Body() body: { fullscreenAtStart?: boolean; screen?: { width: number; height: number } },
    @Req() req: AdminRequest,
  ) {
    return this.databaseService.startEvaluationSession(token, body, req.ip, req.headers['user-agent']);
  }

  @Post('candidate/sessions/:sessionId/answer')
  saveEvaluationAnswer(
    @Param('sessionId') sessionId: string,
    @Body() body: { questionId: string; value: AnswerValue; timeSpentMs?: number },
  ) {
    return this.databaseService.saveEvaluationAnswer(sessionId, body);
  }

  @Post('candidate/sessions/:sessionId/proctor-event')
  recordEvaluationProctorEvent(
    @Param('sessionId') sessionId: string,
    @Body() body: { type: string; occurredAt: string; durationMs?: number; metadata?: Record<string, unknown> },
  ) {
    return this.databaseService.recordEvaluationProctorEvent(sessionId, body);
  }

  @Post('candidate/sessions/:sessionId/heartbeat')
  heartbeatEvaluationSession(@Param('sessionId') sessionId: string) {
    return this.databaseService.heartbeatEvaluationSession(sessionId);
  }

  @Post('candidate/sessions/:sessionId/submit')
  submitEvaluationSession(@Param('sessionId') sessionId: string) {
    return this.databaseService.submitEvaluationSession(sessionId);
  }

  @Get('calendar')
  async getCalendarAppointments() {
    return this.databaseService.getCalendarAppointments();
  }

  @Get('appointments/slots')
  getAppointmentSlots() { return this.databaseService.getAppointmentSlots(); }

  @Post('appointments/slots')
  createAppointmentSlots(@Body() body: { dates: string[]; times: string[] }) {
    return this.databaseService.createAppointmentSlots(body);
  }

  @Delete('appointments/slots/:id')
  deleteAppointmentSlot(@Param('id') id: string) { return this.databaseService.deleteAppointmentSlot(id); }

  @Post('appointments/invite')
  async createAppointmentInvite(@Req() req: AdminRequest, @Body() body: { candidateId: string }) {
    const contact = await this.databaseService.getCandidateMailContact(body.candidateId, req.admin!.organizationId);
    const invite = await this.databaseService.createAppointmentInvite(body.candidateId);
    if (invite.reused) return { ...invite, mail: { sent: false, reason: 'existing-invite' } };
    const base = (process.env.WEB_PUBLIC_URL ?? process.env.FRONTEND_ORIGIN)
      ?.split(',')[0]?.trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\//i.test(base)) return { ...invite, mail: { sent: false, error: 'WEB_PUBLIC_URL yapılandırılmamış.' } };
    const url = new URL(`/randevu/${encodeURIComponent(invite.token)}`, base).toString();
    const name = escapeHtml(contact.fullName);
const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
    <h2 style="color:#0F172A">Mülakat Randevusu</h2>

    <p>Sayın <strong>${name}</strong>,</p>

    <p>Değerlendirme sürecinizin tamamlanması nedeniyle sizi mülakat görüşmesine davet etmek istiyoruz.</p>

    <p>Aşağıdaki bağlantıya tıklayarak size uygun olan randevu gün ve saatini seçebilirsiniz:</p>

    <p style="text-align:center;margin:30px 0">
      <a
        href="${escapeHtml(url)}"
        style="background:#3B82F6;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold"
      >
        Randevu Seç
      </a>
    </p>

    <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin:20px 0;font-size:14px;color:#475569">
      <p style="margin:0 0 8px 0">
        📍 <strong>Adres:</strong> İstoç 32. Ada No:78-80, Bağcılar / İstanbul
      </p>

      <p style="margin:0 0 8px 0">
        📞 <strong>İletişim:</strong> Esra Oğuzdağ —
        <a href="tel:+90 530 129 22 78" style="color:#3B82F6;text-decoration:none">
          +90 530 129 22 78
        </a>
      </p>

      <p style="margin:0">
        <a
          href="https://maps.app.goo.gl/BDcu1pFWMgfWk6Xm8"
          style="color:#3B82F6;text-decoration:none;font-weight:bold"
        >
          🗺 Google Maps'te Görüntüle
        </a>
      </p>
    </div>

    <p style="color:#64748B;font-size:13px">
      Bu bağlantı ${invite.expiresAt.toLocaleDateString("tr-TR")} tarihine kadar geçerlidir.
    </p>

    <hr style="border:none;border-top:1px solid #E2E8F0;margin:20px 0"/>

    <p style="color:#94A3B8;font-size:12px">
      ECR Etkinlik Bilgisayar İnsan Kaynakları
    </p>
  </div>
`;

const text = `Sayın ${contact.fullName},

Mülakat randevunuzu seçmek için:
${url}

Geçerlilik: ${invite.expiresAt.toLocaleDateString("tr-TR")}`;
const mail = contact.email ? await this.emailService.sendRaw(contact.email, 'Mülakat Randevusu - Lütfen Tarih Seçiniz', html, text) : { sent: false, error: 'Adayın e-posta adresi bulunmuyor.' };
    return { ...invite, mail };
  }

  @Post('candidates/:id/reject')
  async rejectCandidate(@Req() req: AdminRequest, @Param('id') id: string) {
    const contact = await this.databaseService.getCandidateMailContact(id, req.admin!.organizationId);
    const result = await this.databaseService.rejectCandidate(id, req.admin!.organizationId);
    if (result.alreadyRejected) return { id: result.id, tags: result.tags, mail: { sent: false, reason: 'already-rejected' } };
    const name = escapeHtml(contact.fullName);
   const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#0F172A">Değerlendirme Sürecimiz Hakkında</h2>
        <p>Merhaba <strong>${contact.fullName}</strong>,</p>
        <p>Görüşmemiz sonrasında yaptığımız değerlendirmede, başvurunuzu bu pozisyon için olumlu sonuçlandıramadık.</p>
        <p>Sürece gösterdiğiniz ilgi ve ayırdığınız zaman için teşekkür eder, bundan sonraki çalışma hayatınızda başarılar dileriz.</p>
        <p>Saygılarımızla,<br/>ECR Etkinlik Bilgisayar</p>
        <hr style="border:none;border-top:1px solid #E2E8F0;margin:20px 0"/>
        <p style="color:#94A3B8;font-size:12px">ECR Etkinlik Bilgisayar İnsan Kaynakları</p>
      </div>
    `;
    const text = `Merhaba ${contact.fullName},\n\nGörüşmemiz sonrasında yaptığımız değerlendirmede, başvurunuzu bu pozisyon için olumlu sonuçlandıramadık.\n\nSürece gösterdiğiniz ilgi ve ayırdığınız zaman için teşekkür eder, bundan sonraki çalışma hayatınızda başarılar dileriz.\n\nSaygılarımızla,\nECR Etkinlik Bilgisayar`;
const mail = contact.email ? await this.emailService.sendRaw(contact.email, 'Değerlendirme Sürecimiz Hakkında', html, text) : { sent: false, error: 'Adayın e-posta adresi bulunmuyor.' };
    return { id: result.id, tags: result.tags, mail };
  }

  @Get('appointments/:token')
  resolveAppointmentInvite(@Param('token') token: string) {
    return this.databaseService.resolveAppointmentInvite(token);
  }

  @Post('appointments/:token/book')
  bookAppointment(@Param('token') token: string, @Body() body: { slotId: string }) {
    return this.databaseService.bookAppointment(token, body.slotId);
  }

  // UPDATE
  @Patch('candidates/:id/score')
  async updateCandidateScore(
    @Param('id') id: string,
    @Body('score') score: number | null,
  ) {
    return this.databaseService.updateCandidateScore(id, score);
  }

  @Post('candidates')
async createCandidate(
  @Req() req: AdminRequest,
  @Body() body: {
    fullName?: string;
    email?: string;
    phone?: string;
    birthDate?: string | null;
    district?: string | null;
    militaryStatus?: string | null;
    hasDriverLicense?: boolean | null;
    driverLicenseType?: string | null;
    activelyDriving?: boolean | null;
    positionId?: string | null;
    source?: string | null;
    foreignLanguage?: string | null;
    totalWorkExperience?: string | null;
    field?: string | null;
  },
) {
  return this.databaseService.createCandidate(
    body,
    req.admin!.organizationId,
  );
}
}
