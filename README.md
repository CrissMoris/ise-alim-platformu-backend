# ECR İşe Alım Platformu — Backend

ECR İşe Alım Platformu'nun backend servisidir. Yönetim paneli, aday işlemleri, değerlendirme süreçleri, e-posta doğrulama, mülakat randevuları ve aday değerlendirme akışları için REST API sağlar.

Backend **NestJS + TypeScript** kullanılarak geliştirilmiştir.

## Teknolojiler

* NestJS
* TypeScript
* Node.js
* PostgreSQL
* `pg`
* Argon2
* Vitest

Veritabanı işlemleri doğrudan PostgreSQL bağlantısı üzerinden gerçekleştirilir. Projede Prisma kullanılmamaktadır.

## Mimari

```text
Frontend
   │
   │ HTTP / REST API
   ▼
NestJS Backend
   │
   ├── Authentication
   ├── Candidate Management
   ├── Evaluation Flow
   ├── Appointment Management
   ├── Email Service
   └── Assessment Scoring
   │
   ▼
PostgreSQL
```

Backend, frontend ile veritabanı arasında API katmanı olarak çalışır. Frontend doğrudan PostgreSQL'e bağlanmaz.

## Proje Yapısı

```text
backend/
├── src/
│   ├── auth/
│   │   ├── auth.guard.ts
│   │   └── auth.service.ts
│   │
│   ├── database/
│   │   ├── database.service.ts
│   │   ├── evaluation-flow.spec.ts
│   │   └── otp.spec.ts
│   │
│   ├── email/
│   │   ├── email.service.ts
│   │   ├── invite-template.ts
│   │   ├── invite-template.spec.ts
│   │   ├── otp-template.ts
│   │   └── otp-template.spec.ts
│   │
│   ├── scoring/
│   │   └── assessment-scoring.ts
│   │
│   ├── app.controller.ts
│   ├── app.module.ts
│   ├── app.service.ts
│   └── main.ts
│
├── test/
│   └── app.e2e-spec.ts
│
├── package.json
├── tsconfig.json
└── nest-cli.json
```

## Temel İşlevler

### Kimlik Doğrulama

Yönetim paneli kullanıcılarının API'ye güvenli şekilde erişmesini sağlar.

* Admin giriş işlemi
* Session token yönetimi
* Authentication guard
* Organizasyon bazlı erişim kontrolü

Şifreler güvenli şekilde **Argon2** kullanılarak doğrulanır.

### Aday Yönetimi

Adaylara ait bilgilerin API üzerinden yönetilmesini sağlar.

Desteklenen bilgiler arasında:

* Ad Soyad
* E-posta
* Telefon
* Doğum tarihi
* İlçe
* Yabancı dil
* Toplam iş tecrübesi
* Bölüm / alan
* Askerlik durumu
* Ehliyet bilgileri
* CV bilgisi
* Başvuru ve değerlendirme bilgileri

bulunur.

### Değerlendirme Davetleri

Yönetici tarafından adaylara değerlendirme daveti oluşturulmasını ve gönderilmesini sağlar.

Akış:

```text
Admin
  ↓
Değerlendirme daveti oluşturulur
  ↓
Adaya e-posta gönderilir
  ↓
/invite/:token
  ↓
E-posta doğrulama
```

Davet tokenları güvenli şekilde işlenir ve mevcut değerlendirme kayıtları korunur.

### E-posta OTP Doğrulaması

Aday değerlendirme bağlantısını açtıktan sonra e-posta adresini tek kullanımlık doğrulama koduyla doğrular.

Akış:

```text
Aday
  ↓
Doğrulama kodu ister
  ↓
6 haneli OTP oluşturulur
  ↓
Kod hash'lenerek saklanır
  ↓
E-posta ile gönderilir
  ↓
Aday kodu girer
  ↓
Kod doğrulanır
```

OTP işlemleri mevcut `EmailVerificationAttempt` kayıtları üzerinden yürütülür.

Kodların geçerlilik süresi, tekrar gönderim aralığı ve hatalı giriş sınırları backend tarafından kontrol edilir.

### Aday Değerlendirme Akışı

Doğrulama sonrasında aday aşağıdaki süreçten geçer:

```text
E-posta doğrulama
       ↓
Aydınlatma ve Onay
       ↓
Değerlendirme Kuralları
       ↓
Değerlendirme
       ↓
Cevapların kaydedilmesi
       ↓
Değerlendirme gönderimi
       ↓
Puanlama
       ↓
Tamamlandı
```

Aday cevapları mevcut veritabanı yapısına kaydedilir ve değerlendirme tamamlandığında sonuçlar hesaplanır.

### Puanlama

`src/scoring/assessment-scoring.ts` içerisinde değerlendirme sonuçlarının hesaplanması gerçekleştirilir.

Puanlama sonucunda ilgili değerlendirme sonuçları ve boyut skorları mevcut veritabanı kayıtlarına işlenir.

### Mülakat ve Randevu

Adayların mülakat randevularının yönetilmesini sağlar.

Akış:

```text
Admin
  ↓
Mülakata Çağır
  ↓
Randevu daveti oluşturulur
  ↓
Adaya e-posta gönderilir
  ↓
/randevu/:token
  ↓
Aday uygun tarih/saat seçer
  ↓
Randevu oluşturulur
```

Müsait randevu slotları ve aday rezervasyonları mevcut veritabanı kayıtları üzerinden yönetilir.

### E-posta Servisi

`src/email/email.service.ts` üzerinden sistem tarafından gönderilen e-postalar yönetilir.

Kullanılan e-posta türleri arasında:

* Değerlendirme daveti
* E-posta doğrulama kodu
* Mülakat randevu daveti

bulunur.

E-posta içerikleri ayrı template dosyalarında tutulur.

## Veritabanı

Backend mevcut PostgreSQL veritabanı ile çalışır.

Veritabanı işlemleri `pg` paketi ve `DatabaseService` üzerinden gerçekleştirilir.

Backend yeni bir veritabanı katmanı oluşturmaz ve frontend tarafından doğrudan veritabanı erişimine izin vermez.

Kullanılan mevcut veri yapıları arasında adaylar, davetler, değerlendirme oturumları, cevaplar, sonuçlar, randevular ve ilgili kayıtlar bulunur.

> Veritabanı bağlantı bilgileri repository içerisinde tutulmaz.

## Ortam Değişkenleri

Backend'in çalışması için gerekli yapılandırmalar environment variable üzerinden sağlanır.

Örnek:

```env
DATABASE_URL=postgresql://...
WEB_PUBLIC_URL=http://localhost:5173
FRONTEND_ORIGIN=http://localhost:5173
COMPANY_NAME=ECR Etkinlik Bilgisayar
```

E-posta gönderimi için kullanılan SMTP / mail servis bilgileri de environment variable olarak yapılandırılmalıdır.

Gerçek şifre, token, API key veya veritabanı bilgileri Git repository'sine eklenmemelidir.

## Kurulum

Repository klonlandıktan sonra:

```bash
cd backend
npm install
```

Gerekli environment variable'lar tanımlandıktan sonra geliştirme sunucusu:

```bash
npm run start:dev
```

Production çalıştırma:

```bash
npm run build
npm run start:prod
```

## Test

Unit testleri çalıştırmak için:

```bash
npm run test
```

E2E testleri:

```bash
npm run test:e2e
```

Test coverage:

```bash
npm run test:cov
```

Belirli bir test dosyasını çalıştırmak için Vitest kullanılabilir.

## Frontend ile Çalışması

Backend ayrı bir repository olarak geliştirilir ve frontend tarafından REST API üzerinden kullanılır.

Frontend repository:

```text
ecr-ise-alim-frontend
```

Temel iletişim:

```text
React / Vite
     │
     │ REST API
     ▼
NestJS
     │
     ▼
PostgreSQL
```

Frontend API adresi environment variable üzerinden backend adresine yönlendirilir.

## Güvenlik

Backend tarafında aşağıdaki güvenlik prensipleri uygulanır:

* Şifrelerin Argon2 ile işlenmesi
* Session tabanlı admin authentication
* Authentication guard
* Organizasyon bazlı erişim kontrolü
* Değerlendirme tokenlarının güvenli şekilde işlenmesi
* OTP kodlarının hash'lenerek saklanması
* Hassas environment variable'ların kaynak kodundan ayrı tutulması
* Public aday endpointlerinde kontrollü erişim

## Geliştirme İlkeleri

Backend geliştirilirken mevcut veritabanı yapısının korunması hedeflenir.

* Gereksiz migration oluşturulmaz.
* Mevcut veritabanı tabloları değiştirilmeden kullanılabilir.
* Frontend doğrudan veritabanına bağlanmaz.
* Veritabanı işlemleri backend üzerinden gerçekleştirilir.
* Hassas bilgiler kaynak koduna yazılmaz.
* API davranışları frontend ile uyumlu tutulur.

## Lisans

Bu proje ECR Etkinlik Bilgisayar'ın iç kullanımına yönelik geliştirilmiştir.
