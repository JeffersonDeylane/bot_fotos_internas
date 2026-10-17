import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TrainingSender, loadTrainingConfig, trainingDate, normalizeTrainingGroup } from '../src/whatsapp/training.ts';

test('reconhece o grupo com variações de maiúsculas, espaços e caracteres invisíveis', () => {
  assert.equal(normalizeTrainingGroup('  O  Treino\u200B '), normalizeTrainingGroup('O treino'));
  assert.notEqual(normalizeTrainingGroup('Outro treino'), normalizeTrainingGroup('O treino'));
});

test('treinos usa data e horário de Brasília na virada e às 06:00', () => {
  assert.deepEqual(trainingDate(new Date('2026-10-17T02:59:00Z')), { date: '16/10/2026', due: true });
  assert.deepEqual(trainingDate(new Date('2026-10-17T08:59:59Z')), { date: '17/10/2026', due: false });
  assert.deepEqual(trainingDate(new Date('2026-10-17T09:00:00Z')), { date: '17/10/2026', due: true });
});

test('agendamento persiste progresso, retoma falhas e comando repete com metas atualizadas', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'treinos-'));
  try {
    const config = path.join(dir, 'config.json');
    const state = path.join(dir, 'state.json');
    const people = [ { nome: 'A', metas: ['a', 'b'] }, { nome: 'B', metas: ['c', 'd'] } ];
    await writeFile(config, JSON.stringify({ grupo: 'O treino', pessoas: people }));
    const sent: string[] = [];
    let fail = true;
    const send = async (_group: string, name: string, options: string[]) => {
      if (name.startsWith('B') && fail) { fail = false; throw new Error('offline'); }
      sent.push(`${name}:${options.join(',')}`);
    };
    const now = new Date('2026-10-16T09:00:00Z');
    const sender = new TrainingSender(state, send, config);
    await sender.run(true, new Date('2026-10-16T08:59:00Z'));
    assert.equal(sent.length, 0);
    await assert.rejects(sender.run(true, now), /offline/);
    const restarted = new TrainingSender(state, send, config);
    await Promise.all([restarted.run(true, now), restarted.run(true, now)]);
    assert.deepEqual(sent, ['A 16/10/2026:a,b', 'B 16/10/2026:c,d']);
    people[0]!.metas = ['nova meta', 'outra meta'];
    await writeFile(config, JSON.stringify({ grupo: 'O treino', pessoas: people }));
    await restarted.run(false, now);
    assert.equal(sent[2], 'A 16/10/2026:nova meta,outra meta');
    await restarted.run(true, new Date('2026-10-17T09:00:00Z'));
    assert.equal(sent.length, 6);
    people[0]!.metas = ['repetida', 'repetida'];
    await writeFile(config, JSON.stringify({ grupo: 'O treino', pessoas: people }));
    await assert.rejects(loadTrainingConfig(config), /inválido/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
