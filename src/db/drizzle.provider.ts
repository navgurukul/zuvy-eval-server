import { Provider } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { DRIZZLE_DB } from './constant';

export const drizzleProvider: Provider = {
  provide: DRIZZLE_DB,
  useFactory: async () => {
    const config = {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      port: 5432,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      ssl: { rejectUnauthorized: false },
    };

    const client = new Client(config);
    await client.connect();
    console.log('🟢 Database connected');

    const db = drizzle(client);

    process.on('beforeExit', async () => {
      await client.end();
      console.log('🔴 Database disconnected');
    });

    return db;
  },
};
