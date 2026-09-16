import { Injectable } from '@nestjs/common';
import { loadAppConfig, type AppConfig } from './config';

@Injectable()
export class RuntimeConfig {
  readonly value: AppConfig = loadAppConfig();
}
