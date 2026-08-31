import dotenv from 'dotenv';

dotenv.config();

/** Matches zuvy-server: ENV_NOTE=stage -> schema "stage", otherwise "main". */
export const DB_SCHEMA_NAME =
  process.env.ENV_NOTE === 'stage' ? 'stage' : 'main';
