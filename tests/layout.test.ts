import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Every stage folder (src/NN_name) has the same layout: index.ts is its public entry
// point and run.ts its offline demo. Code outside a stage imports only its index.ts.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const STAGES = readdirSync(SRC).filter(name => /^\d\d_/.test(name) && statSync(join(SRC, name)).isDirectory());

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('project layout', () => {
  it('has the six pipeline stages', () => {
    assert.deepEqual(STAGES, ['01_signals', '02_enrichment', '03_qualification', '04_contacts', '05_activation', '06_learning']);
  });

  for (const stage of STAGES) {
    it(`${stage} has index.ts and run.ts`, () => {
      assert.ok(existsSync(join(SRC, stage, 'index.ts')), `${stage}/index.ts is missing`);
      assert.ok(existsSync(join(SRC, stage, 'run.ts')), `${stage}/run.ts is missing`);
    });
  }

  it('imports other stages only through their index.ts', () => {
    const violations: string[] = [];
    for (const file of [...tsFiles(SRC), ...tsFiles(join(ROOT, 'tests'))]) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        const target = relative(SRC, resolve(dirname(file), spec!)).split('\\').join('/');
        const match = target.match(/^(\d\d_[^/]+)\/(.+)$/);
        if (!match || match[2] === 'index') continue;
        if (!resolve(file).startsWith(join(SRC, match[1]!) + '/')) {
          violations.push(`${relative(ROOT, file)} imports ${spec}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});
