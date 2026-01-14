
export interface ScriptContent {
  hook: string;
  body: string;
  outro: string;
}

export interface GenerationResult {
  title: string;
  script: ScriptContent;
  imagePrompts: string[];
  bgmPrompt: string; // 전체 배경음악 프롬프트
}

export interface AssetData {
  type: 'image' | 'audio' | 'bgm' | 'video';
  name: string;
  data: string; // base64 or blob URL
  blob?: Blob;
}

export enum GenerationStep {
  IDLE = 'IDLE',
  GENERATING_TEXT = 'GENERATING_TEXT',
  REVIEW = 'REVIEW',
  GENERATING_ASSETS = 'GENERATING_ASSETS',
  PREVIEW_VIDEO = 'PREVIEW_VIDEO',
  FINISHED = 'FINISHED',
  ERROR = 'ERROR'
}
