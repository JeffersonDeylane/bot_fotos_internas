import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';
import { MODEL } from './definition.ts';
import type { InferenceSettings } from './definition.ts';
import { verifyModel } from './artifacts.ts';
import { normalizeEmbedding, preprocessImage } from './preprocessing.ts';
import { AppError } from '../core/errors.ts';

export class LocalEmbeddingModel {
  readonly version = MODEL.version;
  readonly dimension = MODEL.dimension;
  private readonly settings: InferenceSettings;
  private vision: ort.InferenceSession | undefined;
  private text: ort.InferenceSession | undefined;
  private tokenizer: Tokenizer | undefined;
  private busy = false;
  private closed = false;

  private constructor(settings: InferenceSettings) { this.settings = settings; }

  static async create(settings: InferenceSettings): Promise<LocalEmbeddingModel> {
    await verifyModel(settings.modelDirectory);
    const config = JSON.parse(await readFile(path.join(settings.modelDirectory, 'preprocessor_config.json'), 'utf8'));
    if (config.size?.height !== 256 || config.size?.width !== 256 || config.resample !== 2 ||
        JSON.stringify(config.image_mean) !== '[0.5,0.5,0.5]' || JSON.stringify(config.image_std) !== '[0.5,0.5,0.5]') {
      throw new AppError('MODEL_PREPROCESSING_MISMATCH', 'Configuração de imagem incompatível com o pipeline.');
    }
    return new LocalEmbeddingModel(settings);
  }

  private async session(kind: 'vision' | 'text'): Promise<ort.InferenceSession> {
    const current = kind === 'vision' ? this.vision : this.text;
    if (current) return current;
    const session = await ort.InferenceSession.create(path.join(this.settings.modelDirectory, `onnx/${kind}_model_int8.onnx`), {
      executionProviders: ['cpu'], intraOpNumThreads: this.settings.intraOpThreads,
      interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all',
      enableCpuMemArena: false, logSeverityLevel: 3,
    });
    if (kind === 'vision') this.vision = session; else this.text = session;
    return session;
  }

  private enter(): void {
    if (this.closed || this.busy) throw new AppError('INFERENCE_BUSY', 'Sessão fechada ou ocupada; aguarde a operação anterior.');
    this.busy = true;
  }

  private vectors(outputs: ort.InferenceSession.ReturnType, count: number, key: string): Float32Array[] {
    const tensor = outputs[key];
    if (!tensor || tensor.dims.length !== 2 || tensor.dims[0] !== count || tensor.dims[1] !== MODEL.dimension || tensor.type !== 'float32') {
      throw new AppError('MODEL_OUTPUT_MISMATCH', 'Saída do encoder tem nome, dimensão ou tipo inesperado.');
    }
    const data = tensor.data as Float32Array;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < count; i++) vectors.push(normalizeEmbedding(data.subarray(i * MODEL.dimension, (i + 1) * MODEL.dimension)));
    return vectors;
  }

  async embedImages(files: readonly string[]): Promise<Float32Array[]> {
    if (!files.length || files.length > this.settings.batchSize) throw new AppError('INFERENCE_BATCH_LIMIT', 'Lote de imagens fora do limite configurado.');
    this.enter();
    let input: ort.Tensor | undefined;
    let outputs: ort.InferenceSession.ReturnType | undefined;
    try {
      const session = await this.session('vision');
      const plane = 3 * MODEL.size * MODEL.size;
      const data = new Float32Array(files.length * plane);
      for (const [index, file] of files.entries()) data.set(await preprocessImage(file), index * plane);
      input = new ort.Tensor('float32', data, [files.length, 3, MODEL.size, MODEL.size]);
      outputs = await session.run({ pixel_values: input }, ['pooler_output']);
      return this.vectors(outputs, files.length, 'pooler_output');
    } finally {
      input?.dispose();
      if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      this.busy = false;
    }
  }

  async tokenize(texts: readonly string[]): Promise<BigInt64Array> {
    if (!this.tokenizer) {
      const json = JSON.parse(await readFile(path.join(this.settings.modelDirectory, 'tokenizer.json'), 'utf8'));
      const config = JSON.parse(await readFile(path.join(this.settings.modelDirectory, 'tokenizer_config.json'), 'utf8'));
      this.tokenizer = new Tokenizer(json, config);
      if (this.tokenizer.token_to_id('<pad>') !== 0 || this.tokenizer.token_to_id('<eos>') !== 1) throw new Error('TOKENIZER_SPECIAL_TOKENS');
    }
    const data = new BigInt64Array(texts.length * MODEL.textLength); // pad ID=0, à direita
    for (const [index, text] of texts.entries()) {
      if (!text.trim() || text.length > 4096) throw new AppError('INVALID_QUERY', 'Consulta deve ter entre 1 e 4096 caracteres.');
      // Gemma do mesmo checkpoint; EOS após truncar o conteúdo e nenhum BOS.
      const ids = this.tokenizer.encode(text.toLowerCase(), { add_special_tokens: false }).ids.slice(0, MODEL.textLength - 1);
      ids.push(1);
      data.set(BigInt64Array.from(ids, BigInt), index * MODEL.textLength);
    }
    return data;
  }

  async embedTexts(texts: readonly string[]): Promise<Float32Array[]> {
    if (!texts.length || texts.length > 8) throw new AppError('INFERENCE_BATCH_LIMIT', 'Use de 1 a 8 consultas por lote.');
    this.enter();
    let input: ort.Tensor | undefined;
    let outputs: ort.InferenceSession.ReturnType | undefined;
    try {
      const session = await this.session('text');
      input = new ort.Tensor('int64', await this.tokenize(texts), [texts.length, MODEL.textLength]);
      outputs = await session.run({ input_ids: input }, ['pooler_output']);
      return this.vectors(outputs, texts.length, 'pooler_output');
    } finally {
      input?.dispose();
      if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    if (this.busy) throw new AppError('INFERENCE_BUSY', 'Aguarde a inferência antes de fechar a sessão.');
    this.closed = true;
    try { await this.vision?.release(); } finally { await this.text?.release(); }
    this.vision = undefined; this.text = undefined; this.tokenizer = undefined;
  }
}
