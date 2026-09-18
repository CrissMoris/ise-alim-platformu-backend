import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  });

  await app.listen(
    process.env.PORT ?? 3000,
    process.env.HOST ?? '0.0.0.0',
  );
}

await bootstrap();