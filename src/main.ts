import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { DatabaseService } from './database/database.service.js';

async function bootstrap() {
const app = await NestFactory.create(AppModule);
app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' });
  const databaseService = app.get(DatabaseService);
  await databaseService.connect();

  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '127.0.0.1');
}

await bootstrap();
