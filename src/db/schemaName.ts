import dotenv from 'dotenv';

dotenv.config();

/** Matches zuvy-server: ENV_NOTE=stage_template -> schema "stage_template", otherwise "main". */
export const DB_SCHEMA_NAME =
  process.env.ENV_NOTE === 'stage_template' ? 'stage_template' : 'main';
