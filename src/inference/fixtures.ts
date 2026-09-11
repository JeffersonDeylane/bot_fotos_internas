import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FIXTURE_SOURCES = [
  { name: 'cats.png', url: 'https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/coco_sample.png' },
  { name: 'dog.jpg', url: 'https://raw.githubusercontent.com/pytorch/hub/master/images/dog.jpg' },
  { name: 'bus.jpg', url: 'https://raw.githubusercontent.com/ultralytics/yolov5/master/data/images/bus.jpg' },
] as const;

// Download explícito de dados públicos de teste; nunca chamado ao indexar ou pesquisar.
export async function prepareFixtures(cacheDirectory: string, signal: AbortSignal): Promise<void> {
  const directory = path.join(cacheDirectory, 'embedding-fixtures');
  await mkdir(directory, { recursive: true });
  for (const file of FIXTURE_SOURCES) {
    const response = await fetch(file.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) throw new Error(`FIXTURE_HTTP_${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 10_000_000) throw new Error('FIXTURE_SIZE_LIMIT');
    await writeFile(path.join(directory, file.name), new Uint8Array(bytes));
  }
}
