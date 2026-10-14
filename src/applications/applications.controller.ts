import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.service.js';

type UploadedCv = { originalname: string; mimetype: string; size: number; buffer: Buffer };

/** Kariyer formu "Yapıldı/Tecilli/Muaf" gönderir; admin paneli "yapildi/tecilli/muaf" değerlerini bekler. */
function normalizeMilitaryStatus(value: string): 'yapildi' | 'yapilmadi' | 'tecilli' | 'muaf' | null {
  const v = value.trim().toLocaleLowerCase('tr-TR');
  if (['yapıldı', 'yapildi', 'tamamlandı', 'tamamlandi'].includes(v)) return 'yapildi';
  if (v === 'yapilmadi') return 'yapilmadi';
  if (v === 'tecilli') return 'tecilli';
  if (v === 'muaf') return 'muaf';
  return null;
}

/** "linkedin.com/in/x" gibi şemasız girişlere https:// ekler. */
function normalizeUrl(value: string): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * Etkinlik Bilgisayar kariyer sayfasının çağırdığı public başvuru endpoint'i.
 */
@Controller('api/public')
export class ApplicationsController {
  constructor(private database: DatabaseService) {}

  @Post('apply')
  @UseInterceptors(
    FileInterceptor('cv', {
      // storage belirtilmedi → multer varsayılanı memory storage (buffer).
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
      fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
          cb(null, true);
        } else {
          cb(new BadRequestException('Sadece PDF dosyası kabul edilmektedir.'), false);
        }
      },
    }),
  )
  async apply(@Body() body: any, @UploadedFile() cvFile?: UploadedCv) {
    const {
      fullName, email, phone, position, coverLetter, birthDate, district,
      militaryStatus, hasDriverLicense, activelyDriving, driverLicenseType, linkedin,
    } = body ?? {};

    if (!fullName || !email || !phone || !position || !birthDate || !district || !militaryStatus || !hasDriverLicense) {
      throw new BadRequestException('Lütfen zorunlu alanları doldurun.');
    }
    const hasLicense = hasDriverLicense === 'Var';
    if (hasLicense && (!driverLicenseType || !activelyDriving)) {
      throw new BadRequestException('Lütfen ehliyet bilgilerini eksiksiz doldurun.');
    }
    const birth = new Date(String(birthDate).trim());
    if (Number.isNaN(birth.getTime())) {
      throw new BadRequestException('Doğum tarihi geçersiz.');
    }
    const normalizedMilitary = normalizeMilitaryStatus(String(militaryStatus));
    if (!normalizedMilitary) {
      throw new BadRequestException('Askerlik durumu geçersiz.');
    }

    // cvUrl göreli tutulur (/api/uploads/cvs/...).
    let cvUrl: string | null = null;
    if (cvFile) {
      const uploadDir = path.join(process.cwd(), 'uploads', 'cvs');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const safeName = `${Date.now()}-${cvFile.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(uploadDir, safeName), cvFile.buffer);
      cvUrl = `/api/uploads/cvs/${safeName}`;
    }

    await this.database.applyCareerApplication({
      fullName: String(fullName).trim(),
      email: String(email).trim().toLowerCase(),
      phone: String(phone).trim(),
      position: String(position).trim(),
      coverLetter: coverLetter ? String(coverLetter).trim() : null,
      cvUrl,
      birthDate: String(birthDate).trim(),
      district: String(district).trim(),
      militaryStatus: normalizedMilitary,
      hasDriverLicense: hasLicense,
      driverLicenseType: hasLicense && driverLicenseType ? String(driverLicenseType).trim() : null,
      activelyDriving: hasLicense ? activelyDriving === 'Evet' : false,
      linkedin: normalizeUrl(linkedin ? String(linkedin).trim() : '') ?? null,
    });

    // Kariyer formu `response.ok && data.ok` kontrol eder.
    return { ok: true, message: 'Başvurunuz alındı! En kısa sürede sizinle iletişime geçeceğiz.' };
  }
}