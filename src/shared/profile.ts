import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which rule files the engine runs on. By default the template in src/context/. Set
// GTM_PROFILE to run on a client profile instead: a folder with icp.json, personas.json and
// voice.md, usually written by `npm run research` into profiles/<name>/. One engine can
// then serve several clients without editing the template.
//
//   GTM_PROFILE=peec-ai        -> profiles/peec-ai/
//   GTM_PROFILE=./some/folder  -> that folder (relative to the working directory)

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const TEMPLATE_CONTEXT_DIR = join(REPO_ROOT, 'src', 'context');
export const PROFILES_DIR = join(REPO_ROOT, 'profiles');

// The rule files load when modules are imported, before entry points call loadDotEnv(), so
// GTM_PROFILE is also read straight from .env. The test runner (which marks its processes
// with NODE_TEST_CONTEXT) always uses the template, so tests never depend on a profile.
export function selectedProfile(env: NodeJS.ProcessEnv = process.env, envFile = '.env'): string | undefined {
  if (env.NODE_TEST_CONTEXT) return undefined;
  if (env.GTM_PROFILE?.trim()) return env.GTM_PROFILE.trim();
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, 'utf8').match(/^[ \t]*GTM_PROFILE[ \t]*=[ \t]*(.*)$/m)?.[1];
  const value = line?.replace(/#.*$/, '').trim().replace(/^["']|["']$/g, '');
  return value || undefined;
}

export function resolveContextDir(profile: string | undefined, cwd = process.cwd()): string {
  if (!profile) return TEMPLATE_CONTEXT_DIR;
  const isPath = isAbsolute(profile) || /[\\/]/.test(profile) || profile.startsWith('.');
  const dir = isPath ? resolve(cwd, profile) : join(PROFILES_DIR, profile);
  if (!existsSync(dir)) throw new Error(`GTM_PROFILE=${profile}, but ${dir} does not exist. Run \`npm run research -- <domain>\` first, or unset GTM_PROFILE.`);
  return dir;
}

export const ACTIVE_PROFILE = selectedProfile();
export const CONTEXT_DIR = resolveContextDir(ACTIVE_PROFILE);

// Reads one rule file from the active context folder, naming the file on failure.
export function readContextFile(name: string, dir = CONTEXT_DIR): string {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`Rule file missing: ${path}`);
  return readFileSync(path, 'utf8');
}
