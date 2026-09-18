import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async sendRaw(to: string, subject: string, html: string, text: string): Promise<{ sent: boolean; error?: string }> {
    const from = process.env.SMTP_FROM;
    if (!from) return { sent: false, error: 'SMTP_FROM yapılandırılmamış.' };
    try {
      const key = process.env.SENDGRID_API_KEY;
      if (key?.startsWith('SG.')) {
        sgMail.setApiKey(key);
        await sgMail.send({ to, from, subject, html, text });
      } else if (process.env.SMTP_HOST) {
        const port = Number(process.env.SMTP_PORT ?? 587);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT geçersiz.');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port,
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        });
        await transporter.sendMail({ to, from, subject, html, text });
      } else {
        return { sent: false, error: 'SENDGRID_API_KEY veya SMTP_HOST yapılandırılmamış.' };
      }
      return { sent: true };
    } catch (error) {
      this.logger.error(`E-posta gönderilemedi: ${error instanceof Error ? error.message : String(error)}`);
      return { sent: false, error: 'E-posta gönderilemedi. Sunucu mail yapılandırmasını kontrol edin.' };
    }
  }
}
