import { describe, expect, it } from 'vitest';
import { renderInviteMail } from './invite-template.js';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

describe('evaluation invite mail', () => {
  it('renders both logo URLs, the assessment link and safe candidate text', () => {
    const mail = renderInviteMail({
      candidateName: 'Ada <Test>',
      companyName: 'ECR',
      inviteUrl: 'https://example.com/invite/plaintext-token',
      expiresAtHuman: '20.09.2026 12:00',
      webUrl: 'https://example.com',
      sourceNoteHtml: '',
      sourceNoteText: '',
    }, escapeHtml);

    expect(mail.subject).toBe('Değerlendirme Davetiniz — ECR');
    expect(mail.html).toContain('https://example.com/ecr-beyaz.png');
    expect(mail.html).toContain('https://example.com/ecr-logo.png');
    expect(mail.html).toContain('href="https://example.com/invite/plaintext-token"');
    expect(mail.html).toContain('Ada &lt;Test&gt;');
    expect(mail.text).toContain('Ada <Test>');
    expect(mail.text).toContain('https://example.com/invite/plaintext-token');
    expect(mail.html).not.toContain('{{');
  });
});
