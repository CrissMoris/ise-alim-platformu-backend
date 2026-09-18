import { emailShell } from './invite-template.js';

const otpTemplate = {
    key: "otp",
    subject: "Doğrulama Kodunuz",
    bodyHtml: emailShell(`
            <!-- Badge -->
            <p style="margin:0 0 28px;"><span style="display:inline-block;background:#F0FDF4;color:#16A34A;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:6px 14px;border-radius:100px;font-family:'Segoe UI',Arial,sans-serif;">Kimlik Doğrulama</span></p>

            <!-- Greeting -->
            <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0F172A;font-family:'Segoe UI',Arial,sans-serif;line-height:1.3;">Merhaba, {{candidateName}}</p>
            <div style="width:40px;height:3px;background:linear-gradient(90deg,#16A34A,#0D9488);border-radius:2px;margin:0 0 28px;"></div>

            <!-- Body text -->
            <p style="margin:0 0 32px;font-size:15px;color:#475569;font-family:'Segoe UI',Arial,sans-serif;line-height:1.75;">Değerlendirme oturumunuzu başlatmak için aşağıdaki tek kullanımlık doğrulama kodunu kullanın.</p>

            <!-- OTP Code Box -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 32px;">
              <tr>
                <td align="center" style="background:#0F172A;border-radius:14px;padding:36px 32px;">
                  <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#64748B;letter-spacing:0.12em;text-transform:uppercase;font-family:'Segoe UI',Arial,sans-serif;">Doğrulama Kodu</p>
                  <p style="margin:0;font-size:48px;font-weight:800;color:#ffffff;letter-spacing:12px;font-family:'Courier New',Courier,monospace;line-height:1.1;">{{code}}</p>
                </td>
              </tr>
            </table>

            <!-- Warning info -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
              <tr>
                <td style="background:#FEF2F2;border-left:3px solid #EF4444;border-radius:0 8px 8px 0;padding:14px 18px;">
                  <p style="margin:0;font-size:13px;color:#991B1B;font-family:'Segoe UI',Arial,sans-serif;line-height:1.6;">Kod <strong>10 dakika</strong> geçerlidir. Lütfen bu kodu kimseyle paylaşmayın.</p>
                </td>
              </tr>
            </table>
`),
    bodyText: `Merhaba {{candidateName}},

Doğrulama kodunuz: {{code}}

Kod 10 dakika geçerlidir. Bu kodu kimseyle paylaşmayın.

ECR Etkinlik Bilgisayar`,
  };

const render = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');

export function renderOtpMail(candidateName: string, code: string, webUrl: string, companyName: string, escapeHtml: (value: string) => string) {
  return {
    subject: otpTemplate.subject,
    html: render(otpTemplate.bodyHtml, {
      candidateName: escapeHtml(candidateName), code, webUrl: escapeHtml(webUrl), companyName: escapeHtml(companyName),
    }),
    text: render(otpTemplate.bodyText, { candidateName, code }),
  };
}
