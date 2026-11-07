import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadRuntimeEnv(root, environment = process.env) {
  const values = {};
  if (!environment.VERCEL) {
    for (const filename of ['.env', '.env.local']) {
      try {
        for (const line of (await readFile(join(root, filename), 'utf8')).split(/\r?\n/)) {
          const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
          if (!match) continue;
          let value = match[2];
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
          if (value.trim()) values[match[1]] = value.trim();
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (String(value ?? '').trim()) values[name] = String(value).trim();
  }
  return values;
}

export function visitStatsScope(environment = process.env) {
  const scope = environment.VISIT_STATS_SCOPE || environment.VERCEL_ENV || (environment.VERCEL ? 'production' : 'development');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope)) throw new Error('VISIT_STATS_SCOPE 형식을 확인해 주세요.');
  return scope;
}
