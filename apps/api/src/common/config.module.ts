import { Global, Module } from '@nestjs/common';
import { RuntimeConfig } from './runtime-config';

@Global()
@Module({
  providers: [RuntimeConfig],
  exports: [RuntimeConfig],
})
export class AppConfigModule {}
