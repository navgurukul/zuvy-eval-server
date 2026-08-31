import { spawnSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const script = path.resolve(__dirname, '../../scripts/apply-eval-migrations.js');
const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
process.exit(result.status ?? 1);
