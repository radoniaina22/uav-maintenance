import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Clés de la stack Supabase locale : variables d'environnement, sinon `supabase status` */
function loadEnv() {
  const fromEnv = { API_URL: process.env.SUPABASE_URL, ANON_KEY: process.env.SUPABASE_ANON_KEY, SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, DB_URL: process.env.SUPABASE_DB_URL };
  if (fromEnv.API_URL && fromEnv.ANON_KEY && fromEnv.SERVICE_ROLE_KEY && fromEnv.DB_URL) return fromEnv as Record<keyof typeof fromEnv, string>;
  const out = execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const get = (k: string) => out.match(new RegExp(`^${k}="?([^"\\r\\n]+)"?`, 'm'))?.[1] ?? '';
  return { API_URL: get('API_URL'), ANON_KEY: get('ANON_KEY'), SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'), DB_URL: get('DB_URL') };
}
export const ENV = loadEnv();

/** Comptes du jeu de test isolé (créés par global-setup) */
export const PASSWORD = 'E2e-Test-Pass-2026!';
export const USERS = {
  admin: 'e2e-admin@test.local',
  nord: 'e2e-nord@test.local',     // pilote, drone port E2E Nord
  nord2: 'e2e-nord2@test.local',   // copilote, drone port E2E Nord
  sud: 'e2e-sud@test.local',       // pilote, drone port E2E Sud
} as const;
export type UserKey = keyof typeof USERS;

export interface Fixture {
  ports: { nord: string; sud: string };
  drones: { nord: string; sud: string };
  pilots: { nord: string; nord2: string; sud: string };
  csb: string;
}
export const FIXTURE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.fixture.json');
export const fixture = (): Fixture => {
  if (!existsSync(FIXTURE_FILE)) throw new Error('Jeu de test absent : lancez les tests avec « npm run test:e2e »');
  return JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'));
};

/** Client Supabase connecté avec un compte de test */
const cache = new Map<UserKey, SupabaseClient>();
export async function as(user: UserKey): Promise<SupabaseClient> {
  const hit = cache.get(user);
  if (hit) return hit;
  const c = createClient(ENV.API_URL, ENV.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: USERS[user], password: PASSWORD });
  if (error) throw new Error(`Connexion ${USERS[user]} : ${error.message}`);
  cache.set(user, c);
  return c;
}

/** Résultat attendu en erreur : renvoie le message */
export async function expectError(p: PromiseLike<{ error: { message: string } | null; data?: unknown }>): Promise<string> {
  const { error, data } = await p;
  if (!error) throw new Error(`Une erreur était attendue, résultat obtenu : ${JSON.stringify(data)}`);
  return error.message;
}
export async function ok<T>(p: PromiseLike<{ error: { message: string } | null; data: T }>): Promise<T> {
  const { error, data } = await p;
  if (error) throw new Error(error.message);
  return data;
}
