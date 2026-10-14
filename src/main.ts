import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import fs from 'node:fs';
import path from 'node:path';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CV dosyaları eski sistemle aynı yoldan sunulur: GET /api/uploads/cvs/<dosya>
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, { prefix: '/api/uploads' });

  const corsOrigins = [process.env.FRONTEND_ORIGIN, ...(process.env.WEB_PUBLIC_URL ?? '').split(',')]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => Boolean(origin));

  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : 'http://localhost:5173',
  });

  await app.listen(
    process.env.PORT ?? 3000,
    process.env.HOST ?? '0.0.0.0',
  );
}

await bootstrap();