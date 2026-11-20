import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

export const supabase = createClient(url || 'http://localhost', anonKey || 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true },
});

/** Charge toutes les lignes d'une requête paginée (l'API renvoie 1 000 lignes max par appel) */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>) {
  const SIZE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += SIZE) {
    const rows = unwrap(await page(from, from + SIZE - 1));
    out.push(...rows);
    if (rows.length < SIZE) return out;
  }
}

/** Lève une erreur lisible si la requête Supabase a échoué, sinon renvoie les données. */
export function unwrap<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    // .single() sans résultat : élément supprimé ou hors du périmètre (drone port) de l'utilisateur
    if (res.error.code === 'PGRST116') throw new Error("Élément introuvable, ou non accessible depuis votre drone port.");
    throw new Error(res.error.message);
  }
  return res.data as T;
}
