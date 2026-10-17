import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/errors.ts';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, import.meta.url.endsWith('.ts') ? '../..' : '../../..');
const defaultConfigFile = path.join(projectRoot, 'config/treinos.json');

export function normalizeTrainingGroup(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

export interface TrainingConfig { grupo: string; pessoas: { nome: string; metas: string[] }[] }

export async function loadTrainingConfig(file = defaultConfigFile): Promise<TrainingConfig> {
  let config: TrainingConfig;
  try {
    config = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as TrainingConfig;
  } catch (cause) {
    throw new AppError('TRAINING_CONFIG_READ', 'Não foi possível ler config/treinos.json. Confira se o arquivo existe e contém JSON válido.', { cause });
  }
  const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!config || !validText(config.grupo) || !Array.isArray(config.pessoas) || !config.pessoas.length ||
      config.pessoas.some(person => !person || !validText(person.nome) || person.nome.length > 200 ||
        !Array.isArray(person.metas) || person.metas.length < 2 || person.metas.length > 12 ||
        person.metas.some(meta => !validText(meta) || meta.length > 100) || new Set(person.metas).size !== person.metas.length) ||
      new Set(config.pessoas.map(person => person.nome)).size !== config.pessoas.length) {
    throw new AppError('TRAINING_CONFIG_INVALID', 'config/treinos.json inválido: informe grupo, nomes únicos e de 2 a 12 metas distintas por pessoa.');
  }
  return config;
}

export function trainingDate(now: Date): { date: string; due: boolean } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return { date: `${get('day')}/${get('month')}/${get('year')}`, due: Number(get('hour')) >= 6 };
}

export class TrainingSender {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly stateFile: string,
    private readonly send: (group: string, name: string, options: string[]) => Promise<void>,
    private readonly configFile = defaultConfigFile,
  ) {}

  run(automatic: boolean, now = new Date()): Promise<void> {
    const result = this.pending.then(() => this.deliver(automatic, now));
    this.pending = result.catch(() => {});
    return result;
  }

  private async deliver(automatic: boolean, now: Date): Promise<void> {
    const { date, due } = trainingDate(now);
    if (automatic && !due) return;
    let state: { date: string; sent: string[] } = { date, sent: [] };
    if (automatic) {
      try {
        const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as typeof state;
        if (typeof saved.date !== 'string' || !Array.isArray(saved.sent) || saved.sent.some(name => typeof name !== 'string')) throw new Error('Registro de treinos inválido.');
        if (saved.date === date) state = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const config = await loadTrainingConfig(this.configFile);
    for (const person of config.pessoas) {
      const key = `${config.grupo}:${person.nome}`;
      if (automatic && state.sent.includes(key)) continue;
      await this.send(config.grupo, `${person.nome} ${date}`, person.metas);
      if (automatic) {
        state.sent.push(key);
        await writeFile(`${this.stateFile}.tmp`, JSON.stringify(state, null, 2), 'utf8');
        await rename(`${this.stateFile}.tmp`, this.stateFile);
      }
    }
  }
}
