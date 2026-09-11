import sharp from 'sharp';
import { MODEL } from './definition.ts';

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

export function rgbToNchw(rgb: Uint8Array, width: number, height: number): Float32Array {
  const plane = width * height;
  if (rgb.length !== plane * 3) throw new Error('INVALID_RGB_SHAPE');
  const tensor = new Float32Array(rgb.length);
  for (let pixel = 0; pixel < plane; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      tensor[channel * plane + pixel] = (rgb[pixel * 3 + channel]! / 255 - 0.5) / 0.5;
    }
  }
  return tensor;
}

export async function preprocessImage(file: string): Promise<Float32Array> {
  // SigLIP 2: resize direto (não center-crop), PIL resample=2 = bilinear.
  // linear é o kernel triangular/bilinear do libvips; não usar Lanczos padrão.
  const { data, info } = await sharp(file, { limitInputPixels: 100_000_000, sequentialRead: true })
    .rotate().toColourspace('srgb').removeAlpha()
    .resize(MODEL.size, MODEL.size, { fit: 'fill', kernel: 'linear', fastShrinkOnLoad: false })
    .raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error('INVALID_RGB_CHANNELS');
  return rgbToNchw(data, MODEL.size, MODEL.size);
}

export function normalizeEmbedding(input: ArrayLike<number>): Float32Array {
  let squared = 0;
  for (let i = 0; i < input.length; i++) {
    if (!Number.isFinite(input[i])) throw new Error('NON_FINITE_EMBEDDING');
    squared += input[i]! * input[i]!;
  }
  if (squared < 1e-20) throw new Error('ZERO_EMBEDDING');
  const norm = Math.sqrt(squared);
  return Float32Array.from(input, value => value / norm);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum; // Entradas normalizadas L2.
}
