import { Module } from '@nestjs/common';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseService } from './database/database.service.js';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth/auth.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { EmailService } from './email/email.service.js';

@Module({
  imports: [],

  controllers: [AppController],

  providers: [AppService, DatabaseService, AuthService, EmailService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
