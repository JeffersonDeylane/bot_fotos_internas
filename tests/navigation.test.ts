import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NavigationService } from '../src/navigation/service.ts';
import { UserSessions } from '../src/sessions/user-sessions.ts';

test('navega, volta, aceita espaços/número e mantém sessões independentes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'navigation-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(root, 'Fotos de Julho', 'Praia'), { recursive: true });
  await writeFile(path.join(root, 'Fotos de Julho', 'foto.jpg'), 'x');
  const navigation = new NavigationService([root]); const sessions = new UserSessions();
  const a = sessions.get('a'); const b = sessions.get('b');
  const opened = await navigation.open(a, path.basename(root));
  a.lastFolders = opened.folders;
  await navigation.open(a, '1');
  assert.match(navigation.display(a.directory!), /Fotos de Julho/);
  assert.equal((await navigation.photos(a.directory!)).length, 1);
  await navigation.back(a);
  assert.equal(a.directory, root);
  assert.equal(b.directory, undefined);
});

test('recusa traversal, caminho absoluto e junction fora da raiz', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'navigation-safe-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const navigation = new NavigationService([root]); const session = new UserSessions().get('a');
  await assert.rejects(navigation.open(session, '../'), /UNSAFE_PATH/);
  await assert.rejects(navigation.open(session, 'C:\\Windows'), /UNSAFE_PATH/);
});
