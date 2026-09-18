export const emailShell = (content: string) => `<!DOCTYPE html>
<html lang="tr" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>ECR Etkinlik Bilgisayar</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#F1F5F9;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F1F5F9;">
  <tr>
    <td align="center" style="padding:48px 16px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">

        <!-- LOGO HEADER -->
        <tr>
          <td align="center" style="background-color:#0F172A;border-radius:16px 16px 0 0;padding:32px 40px;">
            <img src="{{webUrl}}/ecr-beyaz.png" alt="ECR Etkinlik Bilgisayar" height="44" style="height:44px;max-height:44px;display:block;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>

        <!-- CONTENT CARD -->
        <tr>
          <td style="background-color:#ffffff;padding:48px 48px 40px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0;">
            ${content}
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td align="center" style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 16px 16px;padding:28px 40px;">
            <img src="{{webUrl}}/ecr-logo.png" alt="ECR" height="24" style="height:24px;display:block;margin:0 auto 16px;border:0;opacity:0.45;">
            <p style="margin:0 0 6px;font-size:12px;color:#94A3B8;font-family:'Segoe UI',Arial,sans-serif;line-height:1.6;">Bu e-posta {{companyName}} tarafından gönderilmiştir.</p>
            <p style="margin:0;font-size:12px;color:#CBD5E1;font-family:'Segoe UI',Arial,sans-serif;">© 2026 ECR Etkinlik Bilgisayar. Tüm hakları saklıdır.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;


const inviteTemplate = {
    key: "invite",
    subject: "Değerlendirme Davetiniz — {{companyName}}",
    bodyHtml: emailShell(`
            <!-- Badge -->
            <p style="margin:0 0 28px;"><span style="display:inline-block;background:#EFF6FF;color:#2563EB;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:6px 14px;border-radius:100px;font-family:'Segoe UI',Arial,sans-serif;">Ön Değerlendirme</span></p>

            <!-- Greeting -->
            <p style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0F172A;font-family:'Segoe UI',Arial,sans-serif;line-height:1.3;">Merhaba, {{candidateName}}</p>
            <div style="width:40px;height:3px;background:linear-gradient(90deg,#2563EB,#7C3AED);border-radius:2px;margin:0 0 28px;"></div>

            <!-- Source note (optional) -->
            {{sourceNoteHtml}}

            <!-- Body text -->
            <p style="margin:0 0 20px;font-size:15px;color:#475569;font-family:'Segoe UI',Arial,sans-serif;line-height:1.75;">{{companyName}} bünyesinde gerçekleştirilen işe alım sürecinin bir parçası olarak sizi kişiselleştirilmiş ön değerlendirmemize davet etmekten memnuniyet duyuyoruz.</p>
            <p style="margin:0 0 36px;font-size:15px;color:#475569;font-family:'Segoe UI',Arial,sans-serif;line-height:1.75;">Aşağıdaki butona tıklayarak değerlendirmenize başlayabilirsiniz. Bağlantı <strong style="color:#0F172A;">tek kullanımlıktır</strong> ve belirtilen tarihe kadar geçerlidir.</p>

            <!-- CTA Button -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 36px;">
              <tr>
                <td style="border-radius:10px;background:linear-gradient(135deg,#1E40AF 0%,#7C3AED 100%);box-shadow:0 4px 14px rgba(37,99,235,0.35);">
                  <a href="{{inviteUrl}}" target="_blank" style="display:inline-block;padding:16px 36px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;letter-spacing:0.02em;white-space:nowrap;">Değerlendirmeyi Başlat &rarr;</a>
                </td>
              </tr>
            </table>

            <!-- Expiry info box -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 8px;">
              <tr>
                <td style="background:#FFF7ED;border-left:3px solid #F97316;border-radius:0 8px 8px 0;padding:14px 18px;">
                  <p style="margin:0;font-size:13px;color:#9A3412;font-family:'Segoe UI',Arial,sans-serif;line-height:1.6;"><strong>Son geçerlilik:</strong> {{expiresAtHuman}}</p>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12px;color:#94A3B8;font-family:'Segoe UI',Arial,sans-serif;line-height:1.6;">Butona tıklayamıyor musunuz? Aşağıdaki bağlantıyı tarayıcınıza kopyalayın:<br><a href="{{inviteUrl}}" style="color:#2563EB;word-break:break-all;text-decoration:none;">{{inviteUrl}}</a></p>
`),
    bodyText: `Merhaba {{candidateName}},

{{sourceNoteText}}{{companyName}} ön değerlendirme davetiniz hazır.

Değerlendirmenizi başlatmak için aşağıdaki bağlantıyı kullanın:
{{inviteUrl}}

Bağlantı tek kullanımlıktır ve {{expiresAtHuman}} tarihine kadar geçerlidir.

ECR Etkinlik Bilgisayar`,
  };

function render(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

export function renderInviteMail(values: {
  candidateName: string;
  companyName: string;
  inviteUrl: string;
  expiresAtHuman: string;
  webUrl: string;
  sourceNoteHtml: string;
  sourceNoteText: string;
}, escapeHtml: (value: string) => string) {
  const htmlValues = {
    ...values,
    candidateName: escapeHtml(values.candidateName),
    companyName: escapeHtml(values.companyName),
    inviteUrl: escapeHtml(values.inviteUrl),
    expiresAtHuman: escapeHtml(values.expiresAtHuman),
    webUrl: escapeHtml(values.webUrl),
  };
  return {
    subject: render(inviteTemplate.subject, values),
    html: render(inviteTemplate.bodyHtml, htmlValues),
    text: render(inviteTemplate.bodyText, values),
  };
}
