import { Module } from '@nestjs/common';
import { drizzleProvider } from './drizzle.provider';
import { DRIZZLE_DB } from './constant';

@Module({
  providers: [drizzleProvider],
  exports: [DRIZZLE_DB],
})
export class DbModule {}
