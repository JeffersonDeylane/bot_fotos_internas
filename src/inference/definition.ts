export const MODEL = Object.freeze({
  id: 'onnx-community/siglip2-base-patch16-256-ONNX',
  revision: 'd1114256522a37ffa257a0a58017348ab0058db2',
  dimension: 768,
  size: 256,
  textLength: 64,
  // Altere a versão se mudar pesos, tokenizer, resize, cores, normalização ou runtime numérico.
  version: 'siglip2-base-p16-256@d1114256522a37ffa257a0a58017348ab0058db2:int8:rgb-bilinear-v1:ort1.24.3',
  files: [
    { name: 'config.json', gitSha: '7f5ed0f889a5abc63c40a8ac4cc52fca994bf6d5', size: 458 },
    { name: 'preprocessor_config.json', gitSha: '130986149eee6a6fd9a2eb53da12fbc1a415c0e6', size: 394 },
    { name: 'tokenizer_config.json', gitSha: '13fe208e5d89fb8ffd88805e79b35fe37069108b', size: 47240 },
    { name: 'tokenizer.json', sha256: 'cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322', size: 34363039 },
    { name: 'onnx/text_model_int8.onnx', sha256: '6f59b39d880c413042314b79302b74d0dd93b273caf8fbfdb1eb2df61a7fefd4', size: 283438275 },
    { name: 'onnx/vision_model_int8.onnx', sha256: '8243a496e524bf8fa19830ff42a40a4bae2e97acc2e288d4ae97601edf954977', size: 94737653 },
  ],
});

export interface InferenceSettings {
  readonly enabled: boolean;
  readonly modelDirectory: string;
  readonly intraOpThreads: number;
  readonly batchSize: number;
}
