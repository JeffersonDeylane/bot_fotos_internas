import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Settings } from '../src/config/settings.ts';
import { CommandProcessor, parsePhotoSearch } from '../src/commands/processor.ts';

test('ignora não autorizado, navega, pagina fotos e isola sessões', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commands-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const photos = path.join(root, 'Fotos de Julho');
  for (const dir of [photos, path.join(root, 'database'), path.join(root, 'index'), path.join(root, 'cache'), path.join(root, 'auth')]) await mkdir(dir);
  for (let i = 0; i < 7; i++) await writeFile(path.join(photos, `${i}.jpg`), 'x');
  const settings: Settings = {
    photos: { directories: [root] },
    storage: { databaseDirectory: path.join(root, 'database'), indexDirectory: path.join(root, 'index'), cacheDirectory: path.join(root, 'cache'), whatsAppSessionDirectory: path.join(root, 'auth') },
    processing: { maxWorkers: 1, batchSize: 1 }, whatsapp: { allowedNumbers: ['+5511999999999', '+5511888888888'] },
  };
  const commands = new CommandProcessor(settings);
  assert.deepEqual(await commands.execute('5511777777777@s.whatsapp.net', '/ajuda'), { texts: [], photos: [] });
  const first = '5511999999999@s.whatsapp.net'; const second = '5511888888888@s.whatsapp.net';
  await commands.execute(first, `/abrir-${path.basename(root)}`);
  await commands.execute(first, '/abrir-Fotos de Julho');
  assert.equal((await commands.execute(first, 'enviar todos arquivos')).allFilesDirectory, photos);
  assert.equal((await commands.execute(first, '/enviar todos arquivos')).allFilesDirectory, photos);
  assert.equal((await commands.execute(second, 'enviar todos arquivos')).allFilesDirectory, undefined);
  assert.deepEqual(await commands.execute('5511777777777@s.whatsapp.net', 'enviar todos arquivos'), { texts: [], photos: [] });
  const shown = await commands.execute(first, '/mostrar');
  assert.equal(shown.photos.length, 5);
  assert.equal((await commands.execute(first, '/mais')).photos.length, 2);
  const six = await commands.execute(first, '/mostrar 6');
  assert.equal(six.photos.length, 6);
  assert.equal((await commands.execute(first, '/mais')).photos.length, 1);
  assert.match((await commands.execute(first, '/mostrar 31')).texts[0]!, /1 e 30/);
  assert.match((await commands.execute(first, '/onde')).texts[0]!, /Fotos de Julho/);
  assert.match((await commands.execute(second, '/onde')).texts[0]!, /Raiz/);
  assert.match((await commands.execute(first, '/abrir-..')).texts[0]!, /segurança/);
  assert.match((await commands.execute(first, '/abrir-C:\\Windows')).texts[0]!, /segurança/);
});

test('interpreta quantidade antes da descrição da pesquisa', () => {
  assert.deepEqual(parsePhotoSearch('20 gato preto'), { query: 'gato preto', amount: 20 });
  assert.deepEqual(parsePhotoSearch('10 fotos de pessoas pescando'), { query: 'pessoas pescando', amount: 10 });
  assert.deepEqual(parsePhotoSearch('cachorro na praia'), { query: 'cachorro na praia', amount: 5 });
  assert.throws(() => parsePhotoSearch('31 gato'), /INVALID_PHOTO_AMOUNT/);
});

test('lista e envia arquivos pelo nome, pagina e recusa caminhos externos', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commands-files-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  for (let i = 0; i < 23; i++) await writeFile(path.join(root, `Documento ${i}.txt`), 'teste');
  await mkdir(path.join(root, 'Subpasta'));
  const storage = Object.fromEntries(['databaseDirectory', 'indexDirectory', 'cacheDirectory', 'whatsAppSessionDirectory'].map(key => [key, root])) as Settings['storage'];
  const commands = new CommandProcessor({ photos: { directories: [root] }, storage, processing: { maxWorkers: 1, batchSize: 1 }, whatsapp: { allowedNumbers: ['+5511999999999'] } });
  const jid = '5511999999999@s.whatsapp.net';
  const first = await commands.execute(jid, `/abrir ${path.basename(root)}`);
  assert.equal(first.texts[0]!.split('• ').length - 1, 20);
  assert.match(first.texts[0]!, /mais-arquivos/);
  const next = await commands.execute(jid, '/mais-arquivos');
  assert.equal(next.texts[0]!.split('• ').length - 1, 3);
  assert.match((await commands.execute(jid, '/mais-arquivos')).texts[0]!, /Não há mais/);
  assert.deepEqual((await commands.execute(jid, '/abrir Documento 1.txt')).files, [path.join(root, 'Documento 1.txt')]);
  assert.deepEqual(await commands.execute('5511888888888@s.whatsapp.net', '/abrir Documento 1.txt'), { texts: [], photos: [] });
  for (const name of ['../secreto.txt', 'C:\\Windows\\win.ini', 'Documento 1.txt:stream', 'Subpasta/teste.txt']) {
    const reply = await commands.execute(jid, `/abrir ${name}`);
    assert.equal(reply.files, undefined);
    assert.match(reply.texts[0]!, /segurança/);
  }
  await rm(path.join(root, 'Documento 1.txt'));
  assert.equal((await commands.execute(jid, '/abrir Documento 1.txt')).files, undefined);
  await commands.execute(jid, '/pastas');
  const folder = await commands.execute(jid, '/abrir Subpasta');
  assert.match(folder.texts[0]!, /Nenhum arquivo/);
  assert.match((await commands.execute(jid, '/mais-arquivos')).texts[0]!, /Não há mais/);
});

test('pagina vinte subpastas e seleção numérica usa somente a última listagem', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'commands-folders-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  for (let i = 0; i < 25; i++) await mkdir(path.join(root, `Pasta ${String(i).padStart(2, '0')}`));
  const storage = Object.fromEntries(['databaseDirectory', 'indexDirectory', 'cacheDirectory', 'whatsAppSessionDirectory'].map(key => [key, root])) as Settings['storage'];
  const commands = new CommandProcessor({ photos: { directories: [root] }, storage, processing: { maxWorkers: 1, batchSize: 1 }, whatsapp: { allowedNumbers: ['+5511999999999'] } });
  const jid = '5511999999999@s.whatsapp.net';
  await commands.execute(jid, `/abrir-${path.basename(root)}`);
  const page = await commands.execute(jid, '/pastas');
  assert.match(page.texts[0]!, /1-20 de 25/);
  assert.match((await commands.execute(jid, '/mais-pastas')).texts[0]!, /21-25 de 25/);
  await commands.execute(jid, '/abrir 21');
  assert.match((await commands.execute(jid, '/onde')).texts[0]!, /Pasta 20/);
});
