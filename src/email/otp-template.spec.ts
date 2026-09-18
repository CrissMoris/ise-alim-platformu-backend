import { describe, expect, it } from 'vitest';
import { renderOtpMail } from './otp-template.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

describe('OTP mail template', () => {
  it('renders the OLD email text and safely escapes the HTML name', () => {
    const mail = renderOtpMail('Ada <Test>', '123456', 'https://example.com', 'ECR', escapeHtml);
    expect(mail.subject).toBe('Doğrulama Kodunuz');
    expect(mail.html).toContain('Ada &lt;Test&gt;');
    expect(mail.html).toContain('https://example.com/ecr-beyaz.png');
    expect(mail.html).toContain('https://example.com/ecr-logo.png');
    expect(mail.html).toContain('123456');
    expect(mail.text).toContain('Doğrulama kodunuz: 123456');
    expect(mail.text).toContain('Ada <Test>');
    expect(mail.html).not.toContain('{{');
  });
});
