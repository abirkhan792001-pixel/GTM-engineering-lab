import { existsSync } from 'node:fs';

// Load KEY=value pairs from a local .env file into process.env (Node's built-in parser;
// no dependency). Variables already set in the environment win, so CI secrets are never
// overridden by a stray file. Call this from entry-point scripts only, never from library code.
export function loadDotEnv(path = '.env'): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
