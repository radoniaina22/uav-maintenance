import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { as, ok, PASSWORD, USERS } from './env';
import type { UserKey } from './env';

/** Parcours de l'interface dans le navigateur */

async function login(page: Page, user: UserKey) {
  await page.goto('/');
  await page.getByPlaceholder('prenom.nom@exemple.org').fill(USERS[user]);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.locator('.appbar')).toBeVisible({ timeout: 20_000 });
}

/** Erreurs JavaScript de la page (hors ressources réseau externes : tuiles de carte, météo) */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|tile\.openstreetmap|open-meteo|net::ERR/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test('connexion refusée avec un mauvais mot de passe', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('prenom.nom@exemple.org').fill(USERS.nord);
  await page.locator('input[type=password]').fill('mauvais-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByText('Email ou mot de passe incorrect.')).toBeVisible();
});

test('le formulaire d\'inscription crée un compte Pilote par défaut', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Créer un compte pilote' }).click();
  await expect(page.getByText('Rejoindre')).toBeVisible();
  await expect(page.locator('.signup-role')).toContainText('Pilote');
});

const ADMIN_PAGES = [
  ['/', 'Tableau de bord'], ['/vols', 'Vols'], ['/carnet', 'Carnet'], ['/classement', 'Classement'], ['/statistiques', 'Statistiques'],
  ['/consommation', 'Consommation'], ['/rapports', 'Rapports'], ['/drones', 'Drones'], ['/ordres-travail', 'Ordres de travail'],
  ['/pieces', 'Pièces'], ['/batteries', 'Batteries'], ['/pilotes', 'Pilotes'], ['/csb', 'Formations sanitaires'],
  ['/drone-ports', 'Drone ports'], ['/utilisateurs', 'Utilisateurs'], ['/audit', 'Journal d\'audit'], ['/crm/export', 'Export des CRM'],
  ['/rapports-mensuels?type=pilotes', 'Rapports mensuels'], ['/rapports-mensuels?type=admin', 'Rapports mensuels'],
  ['/rapports-mensuels?type=unfpa', 'Rapports mensuels'],
] as const;

test('toutes les pages s\'affichent sans erreur (administrateur)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await login(page, 'admin');
  for (const [path, title] of ADMIN_PAGES) {
    await page.goto(`/#${path}`);
    await expect(page.locator('.appbar-page'), `page ${path}`).toContainText(title);
    await expect(page.locator('.loading, .skeleton')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('n\'a pas pu s\'afficher'), `page ${path}`).toHaveCount(0);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('un pilote n\'a pas accès à l\'administration', async ({ page }) => {
  await login(page, 'nord');
  await expect(page.locator('.sidebar')).not.toContainText('Utilisateurs');
  await expect(page.locator('.sidebar')).not.toContainText('Journal d\'audit');
  await page.goto('/#/utilisateurs');
  await expect(page.locator('.appbar-page')).toContainText('Tableau de bord');
  await expect(page.locator('.port-name')).toContainText('E2E Nord');
});

test('un pilote ne voit que le rapport mensuel technique de son drone port', async ({ page }) => {
  await login(page, 'nord');
  const month = new Date().toISOString().slice(0, 7);
  await page.goto(`/#/rapports-mensuels?mois=${month}&type=unfpa`);
  await expect(page.locator('.mr-sheet h1')).toHaveText('Rapport technique mensuel');
  await expect(page.locator('.mr-sheet .mr-sub').first()).toContainText('E2E Nord');
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('l\'administrateur commente, valide puis rouvre le rapport UNFPA', async ({ page }) => {
  await login(page, 'admin');
  page.on('dialog', (d) => d.accept());
  await page.goto('/#/rapports-mensuels?type=unfpa&mois=2001-02');
  const panel = page.locator('.mr-validation');
  await expect(panel).toContainText('Brouillon');
  await panel.locator('textarea').fill('Saison des pluies : peu de vols (test UI)');
  await panel.getByRole('button', { name: 'Valider et figer les chiffres' }).click();
  await expect(panel.locator('.badge')).toHaveText('Validé');
  await expect(panel.locator('textarea')).toBeDisabled();
  await expect(page.locator('.mr-sheet')).toContainText('Faits marquants');
  await expect(page.locator('.mr-sheet')).toContainText('Saison des pluies : peu de vols (test UI)');
  await expect(page.locator('.mr-sheet .mr-head')).toContainText('Validé le');
  await panel.getByRole('button', { name: 'Rouvrir le rapport' }).click();
  await expect(panel.locator('.badge')).toHaveText('Brouillon');
  await expect(page.locator('.mr-sheet .mr-head')).toContainText('Brouillon : non validé');
});

test('l\'administrateur colle une liste de destinataires UNFPA puis en désactive un', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/#/rapports-mensuels?type=destinataires');
  await page.getByRole('button', { name: 'Coller une liste' }).click();
  const modal = page.locator('.modal');
  await modal.locator('textarea').fill([
    'Hery Test ; Chargé de programme ; hery@e2e.test',
    'Mialy Test <mialy@e2e.test>',
    'ligne sans adresse',
  ].join('\n'));
  await expect(modal).toContainText('2 nouveau(x) destinataire(s)');
  await modal.getByRole('button', { name: 'Ajouter 2 destinataire(s)' }).click();
  const row = page.locator('tr', { hasText: 'mialy@e2e.test' });
  await expect(page.locator('tr', { hasText: 'hery@e2e.test' })).toContainText('Chargé de programme');
  await row.getByRole('button', { name: 'Désactiver' }).click();
  await expect(row).toContainText('Désactivé');
  await expect(page.locator('.rr-group', { hasText: 'E2E Nord' })).toContainText('e2e-nord@test.local');
});

test('un pilote ouvre un ordre de travail depuis l\'interface', async ({ page }) => {
  await login(page, 'nord');
  await page.goto('/#/ordres-travail');
  await page.getByRole('button', { name: '+ Nouvel OT' }).click();
  const modal = page.locator('.modal');
  await modal.getByRole('button', { name: 'E2E1' }).click();
  await modal.getByPlaceholder('ex. Remplacement hélice VTOL avant gauche').fill('Inspection après atterrissage dur (test UI)');
  await modal.getByRole('button', { name: 'Ouvrir l\'OT' }).click();
  await expect(page).toHaveURL(/#\/ordres-travail\/[0-9a-f-]{36}$/);
  await expect(page.locator('.wo-title')).toContainText(/OT-\d{4}-\d{4}/);
  await expect(page.locator('.wo-stepper .current')).toContainText('Ouvert');
});

test('une batterie se crée sans numéro de série depuis l\'interface', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/#/batteries');
  await page.getByRole('button', { name: '+ Batterie' }).click();
  const modal = page.locator('.modal');
  await expect(modal.locator('.field-hint', { hasText: 'facultatif' }).first()).toBeVisible();
  await modal.locator('select').last().selectOption({ label: 'E2E Nord' });
  await modal.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(modal).toHaveCount(0);
  const admin = await as('admin');
  const last = await ok(admin.from('v_battery_status').select('serial_number, drone_port_name').eq('drone_port_name', 'E2E Nord').is('pack_id', null).order('created_at', { ascending: false }).limit(1).single());
  expect(last.serial_number).toBeNull();
  await page.reload();
  await expect(page.locator('.bloose-item', { hasText: 'E2E Nord' }).filter({ hasText: 'sans n° de série' })).not.toHaveCount(0);
});