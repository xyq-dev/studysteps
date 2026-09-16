import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-exception.filter';
import { loadAppConfig } from './common/config';

async function bootstrap() {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
  });
  await app.listen(config.port, config.listenHost);
}

void bootstrap();
