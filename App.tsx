
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Type, Modality } from "@google/genai";
import JSZip from 'jszip';
import { 
  Sparkles, Download, Image as ImageIcon, Mic, FileText, Loader2, CheckCircle2, 
  AlertCircle, Snowflake, Type as TypeIcon, ArrowRight, PencilLine, RefreshCcw, 
  Play, Wand2, Layers, Maximize2, Palette, Music, Video, Pause, Upload, Film, Link2, Key
} from 'lucide-react';
import { GenerationStep, GenerationResult, AssetData } from './types';
import { decodeBase64, createWavBlob } from './utils/audio';

// 전역 타입 선언
// AIStudio 인터페이스를 명시적으로 정의하고 window.aistudio를 readonly로 선언하여 환경과 일치시킵니다.
declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }

  interface Window {
    readonly aistudio: AIStudio;
  }
}

const STYLES = [
  "실사 (Realism)", "3D 애니메이션 (3D Animation)", "인상주의 (Impressionism)", 
  "큐비즘 (Cubism)", "리얼리즘 (Realism)", "초 surrealism (Surrealism)", "종이 (Paper)", 
  "표현주의 (Expressionism)", "미니멀리즘 (Minimalism)", "픽셀 아트 (Pixel Art)", 
  "만화와 코믹스 (Cartoon and Comics)", "수채화 (Watercolor)", "스케치 (Sketch)"
];

const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:3", "3:4"];

interface TimedCaption {
  text: string;
  startTime: number;
  endTime: number;
  section: 'hook' | 'body' | 'outro';
}

const App: React.FC = () => {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [topic, setTopic] = useState<string>('겨울철 별미');
  const [imageCount, setImageCount] = useState<string>('5');
  const [aspectRatio, setAspectRatio] = useState<string>("9:16");
  const [selectedStyle, setSelectedStyle] = useState<string>("실사 (Realism)");
  const [customStyle, setCustomStyle] = useState<string>("");

  const [step, setStep] = useState<GenerationStep>(GenerationStep.IDLE);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [assets, setAssets] = useState<AssetData[]>([]);
  const [isRegenerating, setIsRegenerating] = useState<{ [key: string]: boolean }>({});
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);

  // API 키 확인 로직
  useEffect(() => {
    const checkKey = async () => {
      const selected = await window.aistudio.hasSelectedApiKey();
      setHasKey(selected);
    };
    checkKey();
  }, []);

  const handleOpenKeySelector = async () => {
    await window.aistudio.openSelectKey();
    // 레이스 컨디션 방지: 즉시 성공으로 가정하고 진행
    setHasKey(true);
  };

  // 최신 API 인스턴스 생성 (선택된 키 반영을 위해 매번 새로 생성)
  const getAi = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

  const callWithRetry = async (fn: () => Promise<any>, maxRetries = 3) => {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const msg = err.message || "";
        // API 키 유실 에러 대응
        if (msg.includes("Requested entity was not found")) {
          setHasKey(false);
          throw new Error("API 키가 유효하지 않거나 프로젝트를 찾을 수 없습니다. 다시 연결해주세요.");
        }
        // 할당량 초과 에러 대응 (지수 백오프)
        if (msg.includes('429') || err.status === 429) {
          const delay = Math.pow(2, i) * 1500 + Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  };

  const handleTogglePlay = () => setIsPlaying(!isPlaying);

  const startTextGeneration = async () => {
    if (!topic.trim()) {
      setError('주제를 입력해주세요.');
      return;
    }
    try {
      setError(null);
      setAssets([]);
      setProgress(10);
      setStep(GenerationStep.GENERATING_TEXT);
      const ai = getAi();
      const styleToUse = customStyle.trim() || selectedStyle;
      const countToUse = parseInt(imageCount === 'auto' ? '5' : imageCount);
      const adjustedCount = Math.max(3, countToUse);

      const textResponse = await callWithRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-preview', // 고성능 프로 모델 사용
        contents: `주제: "${topic}"에 대한 30초 분량의 쇼츠 대본을 작성하고, 각 파트에 맞는 이미지 프롬프트를 생성해줘.
        
        1. 대본 구조:
           - Hook: 시선을 끄는 첫 문장 (약 5초)
           - Body: 핵심 내용 설명 (약 20초, 최소 3문장 이상)
           - Outro: 마무리 및 행동 유도 (약 5초)
        
        2. 이미지 프롬프트 구성 (총 ${adjustedCount}개):
           - 첫 번째 프롬프트: Hook 전용.
           - 마지막 프롬프트: Outro 전용.
           - 중간 프롬프트들: Body의 전개에 맞춘 순차적 장면들.
        
        3. 모든 이미지는 "${styleToUse}" 스타일이어야 해.
        4. 배경음악 스타일(bgmPrompt)도 영어로 한 문장 생성해줘.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              script: {
                type: Type.OBJECT,
                properties: {
                  hook: { type: Type.STRING },
                  body: { type: Type.STRING },
                  outro: { type: Type.STRING }
                },
                required: ['hook', 'body', 'outro']
              },
              imagePrompts: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                minItems: adjustedCount
              },
              bgmPrompt: { type: Type.STRING }
            },
            required: ['title', 'script', 'imagePrompts', 'bgmPrompt']
          }
        }
      }));

      const data = JSON.parse(textResponse.text || '{}') as GenerationResult;
      setResult(data);
      setStep(GenerationStep.REVIEW);
    } catch (err: any) {
      setError(err.message || '대본 생성 중 오류가 발생했습니다.');
      setStep(GenerationStep.ERROR);
    }
  };

  const startAssetGeneration = async () => {
    if (!result) return;
    try {
      setError(null);
      setProgress(0);
      setStep(GenerationStep.GENERATING_ASSETS);
      const ai = getAi();
      const generatedAssets: AssetData[] = [];
      
      for (let i = 0; i < result.imagePrompts.length; i++) {
        const imgResponse = await callWithRetry(() => ai.models.generateContent({
          model: 'gemini-3-pro-image-preview', // 고화질 이미지 생성 모델
          contents: result.imagePrompts[i],
          config: { 
            imageConfig: { 
              aspectRatio: aspectRatio as any,
              imageSize: "1K" // 1K 해상도 고정
            } 
          }
        }));
        
        const part = imgResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (part?.inlineData) {
          const blob = new Blob([decodeBase64(part.inlineData.data)], { type: 'image/png' });
          generatedAssets.push({ type: 'image', name: `image_${i + 1}.png`, data: URL.createObjectURL(blob), blob });
        }
        setProgress(Math.floor(((i + 1) / (result.imagePrompts.length + 2)) * 100));
      }

      const fullText = `${result.script.hook}. ${result.script.body}. ${result.script.outro}`;
      const audioResponse = await callWithRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: fullText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      }));
      const audioData = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audioData) {
        const blob = createWavBlob(decodeBase64(audioData));
        generatedAssets.push({ type: 'audio', name: 'narration.wav', data: URL.createObjectURL(blob), blob });
      }

      setAssets(generatedAssets);
      setStep(GenerationStep.FINISHED);
    } catch (err: any) {
      setError(err.message || '에셋 생성 중 오류가 발생했습니다.');
      setStep(GenerationStep.ERROR);
    }
  };

  const handleBgmUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setAssets(prev => [
        ...prev.filter(a => a.type !== 'bgm'),
        { type: 'bgm', name: 'uploaded_bgm.mp3', data: url, blob: file }
      ]);
    }
  };

  const regenerateAudio = async () => {
    if (!result) return;
    setIsRegenerating(prev => ({ ...prev, audio: true }));
    try {
      const ai = getAi();
      const audioResponse = await callWithRetry(() => ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: `${result.script.hook}. ${result.script.body}. ${result.script.outro}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      }));
      const data = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (data) {
        const blob = createWavBlob(decodeBase64(data));
        setAssets(prev => [...prev.filter(a => a.type !== 'audio'), { type: 'audio', name: 'narration.wav', data: URL.createObjectURL(blob), blob }]);
      }
    } catch (err) { console.error(err); }
    finally { setIsRegenerating(prev => ({ ...prev, audio: false })); }
  };

  const regenerateSingleImage = async (index: number) => {
    if (!result) return;
    setIsRegenerating(prev => ({ ...prev, [`image_${index}`]: true }));
    try {
      const ai = getAi();
      const imgRes = await callWithRetry(() => ai.models.generateContent({
        model: 'gemini-3-pro-image-preview',
        contents: result.imagePrompts[index],
        config: { imageConfig: { aspectRatio: aspectRatio as any, imageSize: "1K" } }
      }));
      const data = imgRes.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
      if (data) {
        const blob = new Blob([decodeBase64(data)], { type: 'image/png' });
        const name = `image_${index + 1}.png`;
        setAssets(prev => {
          const next = [...prev];
          const idx = next.findIndex(a => a.name === name);
          const item = { type: 'image' as const, name, data: URL.createObjectURL(blob), blob };
          if (idx !== -1) next[idx] = item; else next.push(item);
          return next;
        });
      }
    } catch (err) { console.error(err); }
    finally { setIsRegenerating(prev => ({ ...prev, [`image_${index}`]: false })); }
  };

  const getTimedCaptions = (script: {hook: string, body: string, outro: string}, duration: number): TimedCaption[] => {
    const captions: TimedCaption[] = [];
    const MAX_CHARS = 24;

    const splitText = (text: string): string[] => {
      const sentences = text.split(/[.!?]\s+/).filter(s => s.trim().length > 0).map(s => s.trim() + (/[.!?]$/.test(s) ? '' : '.'));
      const chunks: string[] = [];
      sentences.forEach(s => {
        if (s.length <= MAX_CHARS) {
          chunks.push(s);
        } else {
          const parts = s.split(/([,])\s+/).filter(Boolean);
          let currentChunk = "";
          parts.forEach(p => {
            if ((currentChunk + p).length > MAX_CHARS && currentChunk !== "") {
              chunks.push(currentChunk.trim());
              currentChunk = p;
            } else {
              currentChunk += p;
            }
          });
          if (currentChunk) chunks.push(currentChunk.trim());
        }
      });
      return chunks;
    };

    const hookChunks = splitText(script.hook);
    const bodyChunks = splitText(script.body);
    const outroChunks = splitText(script.outro);

    const totalChars = (hookChunks.join('') + bodyChunks.join('') + outroChunks.join('')).length;
    let accumulatedChars = 0;

    const mapToTimed = (chunks: string[], section: 'hook' | 'body' | 'outro') => {
      chunks.forEach(text => {
        const start = (accumulatedChars / totalChars) * duration;
        accumulatedChars += text.length;
        const end = (accumulatedChars / totalChars) * duration;
        captions.push({ text, startTime: start, endTime: end, section });
      });
    };

    mapToTimed(hookChunks, 'hook');
    mapToTimed(bodyChunks, 'body');
    mapToTimed(outroChunks, 'outro');

    return captions;
  };

  useEffect(() => {
    if (step !== GenerationStep.FINISHED || !canvasRef.current || !result) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const images = assets.filter(a => a.type === 'image');
    const audio = audioRef.current;
    const bgm = bgmRef.current;

    const [w, h] = aspectRatio === '9:16' ? [720, 1280] : 
                 aspectRatio === '16:9' ? [1280, 720] : 
                 aspectRatio === '1:1' ? [1000, 1000] : 
                 aspectRatio === '4:3' ? [1000, 750] : [750, 1000];
    canvas.width = w;
    canvas.height = h;

    const duration = audio?.duration || 10;
    const allCaptions = getTimedCaptions(result.script, duration);

    let frameId: number;
    const render = () => {
      const time = audio?.currentTime || 0;
      setCurrentTime(time);
      
      const currentCap = allCaptions.find(s => time >= s.startTime && time < s.endTime) || allCaptions[allCaptions.length - 1];
      
      let currentImgIdx = 0;
      if (currentCap?.section === 'hook') {
        currentImgIdx = 0;
      } else if (currentCap?.section === 'outro') {
        currentImgIdx = images.length - 1;
      } else {
        const bodyS = allCaptions.find(s => s.section === 'body')?.startTime || 0;
        const bodyE = [...allCaptions].reverse().find(s => s.section === 'body')?.endTime || duration;
        const prog = (time - bodyS) / (bodyE - bodyS || 1);
        const bCount = images.length - 2;
        currentImgIdx = 1 + Math.min(Math.floor(prog * bCount), bCount - 1);
      }

      const imgAsset = images[currentImgIdx];
      if (imgAsset) {
        const img = new Image();
        img.src = imgAsset.data;
        ctx.drawImage(img, 0, 0, w, h);
      }

      if (currentCap) {
        const fontSize = Math.floor(w * 0.05);
        ctx.font = `bold ${fontSize}px Pretendard`;
        ctx.textAlign = "center";
        
        const maxWidth = w * 0.85;
        const words = currentCap.text.split(' ');
        const lines: string[] = [];
        let currentLine = words[0];
        for (let i = 1; i < words.length; i++) {
          if (ctx.measureText(currentLine + " " + words[i]).width < maxWidth) {
            currentLine += " " + words[i];
          } else {
            lines.push(currentLine);
            currentLine = words[i];
          }
        }
        lines.push(currentLine);
        const finalLines = lines.slice(0, 2);

        const lHeight = fontSize * 1.35;
        const pad = fontSize * 0.8;
        const bHeight = (finalLines.length * lHeight) + pad;
        const bY = h * 0.85 - (bHeight / 2);

        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.beginPath();
        ctx.roundRect(w * 0.08, bY, w * 0.84, bHeight, 20);
        ctx.fill();

        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 10;
        ctx.fillStyle = "#FFFFFF";
        finalLines.forEach((l, i) => {
          const y = bY + pad / 2 + (i + 1) * fontSize + (i * (lHeight - fontSize));
          ctx.fillText(l, w / 2, y);
        });
        ctx.shadowBlur = 0;
      }

      if (isPlaying) frameId = requestAnimationFrame(render);
    };

    if (isPlaying) {
      audio?.play().catch(() => {});
      bgm?.play().catch(() => {});
      render();
    } else {
      audio?.pause();
      bgm?.pause();
      render();
    }

    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, step, assets, result, aspectRatio]);

  const exportVideo = async () => {
    if (!canvasRef.current || isExporting) return;
    setIsExporting(true);
    setIsPlaying(false);
    
    const canvas = canvasRef.current;
    const stream = canvas.captureStream(30);
    const audio = audioRef.current;
    
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${result?.title || 'shorts'}.webm`;
      a.click();
      setIsExporting(false);
    };

    recorder.start();
    if (audio) {
      audio.currentTime = 0;
      setIsPlaying(true);
      audio.onended = () => {
        recorder.stop();
        setIsPlaying(false);
        audio.onended = null;
      };
    } else {
      setTimeout(() => recorder.stop(), 5000);
    }
  };

  const handleEditResult = (field: string, value: any) => {
    if (!result) return;
    if (field.includes('.')) {
      const [p, c] = field.split('.');
      setResult({ ...result, [p]: { ...(result as any)[p], [c]: value } });
    } else setResult({ ...result, [field]: value });
  };

  // API 키 선택 화면
  if (hasKey === false) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-[40px] p-10 shadow-2xl text-center space-y-8 animate-in zoom-in duration-500">
          <div className="w-20 h-20 bg-blue-100 rounded-3xl flex items-center justify-center mx-auto text-blue-600">
            <Key size={40} />
          </div>
          <div className="space-y-4">
            <h2 className="text-3xl font-black text-slate-900 tracking-tight">API 키 연결 필요</h2>
            <p className="text-slate-600 font-medium leading-relaxed">
              할당량 문제를 해결하고 고품질 Gemini 3 Pro 모델을 사용하기 위해 <b>Google AI Studio API 키</b>를 연결해주세요.
            </p>
          </div>
          <div className="space-y-3 pt-4">
            <button onClick={handleOpenKeySelector} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-5 rounded-2xl font-black text-xl shadow-xl transition-all hover:scale-105 active:scale-95 flex items-center justify-center gap-3">
              <Link2 size={24} /> API 키 연결하기
            </button>
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="block text-sm font-bold text-slate-400 hover:text-blue-500 transition-colors">
              결제 및 한도 안내 확인하기
            </a>
          </div>
        </div>
        <p className="mt-8 text-slate-500 text-xs font-bold tracking-widest uppercase">Gemini AI Creative Shorts Studio v2.4</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-12 px-4">
      <div className="max-w-4xl w-full text-center mb-10">
        <div className="inline-flex items-center justify-center p-3 bg-blue-100 rounded-2xl mb-4 text-blue-600 shadow-sm relative">
          <Snowflake size={32} />
          <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 border-2 border-white rounded-full" title="API 연결됨" />
        </div>
        <h1 className="text-4xl font-extrabold text-slate-900 mb-2 tracking-tight">AI 숏폼 마스터 PRO</h1>
        <p className="text-slate-600 font-medium text-lg flex items-center justify-center gap-2">
          Gemini 3 Pro <Sparkles size={16} className="text-yellow-500" /> 기반 고품질 영상 제작
        </p>
      </div>

      <div className="max-w-6xl w-full bg-white rounded-3xl shadow-2xl p-8 border border-slate-100 relative overflow-hidden">
        {step === GenerationStep.IDLE && (
          <div className="flex flex-col items-center gap-6 py-10 max-w-2xl mx-auto">
            <div className="w-full space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-500 flex items-center gap-2 px-1"><TypeIcon size={16} /> 쇼츠 주제</label>
                <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)} className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-blue-500 outline-none text-xl font-bold shadow-inner transition-all" placeholder="주제를 입력하세요..." />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-500 flex items-center gap-2 px-1"><Layers size={16} /> 이미지 개수</label>
                  <select value={imageCount} onChange={(e) => setImageCount(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-xl font-semibold outline-none focus:border-blue-500 transition-all">
                    {[...Array(18)].map((_, i) => <option key={i+3} value={i+3}>{i+3}개 (Pro 1K 고화질)</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-500 flex items-center gap-2 px-1"><Maximize2 size={16} /> 화면 비율</label>
                  <div className="grid grid-cols-3 gap-2">
                    {ASPECT_RATIOS.map(r => (
                      <button key={r} onClick={() => setAspectRatio(r)} className={`py-2 text-xs font-bold rounded-lg border-2 transition-all ${aspectRatio === r ? 'border-blue-600 bg-blue-50 text-blue-600' : 'border-slate-100 bg-slate-50 text-slate-400 hover:border-slate-200'}`}>{r}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-500 flex items-center gap-2 px-1"><Palette size={16} /> 비주얼 스타일</label>
                <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border-2 border-slate-100 rounded-xl font-semibold outline-none focus:border-blue-500 transition-all">
                  {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button onClick={startTextGeneration} className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 text-white px-8 py-5 rounded-2xl font-black text-2xl transition-all shadow-xl hover:-translate-y-1 active:scale-95"><Sparkles size={28} /> 쇼츠 대본 기획하기</button>
            </div>
          </div>
        )}

        {(step === GenerationStep.GENERATING_TEXT || step === GenerationStep.GENERATING_ASSETS) && (
          <div className="w-full py-24 flex flex-col items-center gap-6">
            <div className="relative">
               <Loader2 className="animate-spin text-blue-600" size={72} />
               <Sparkles className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-400 animate-pulse" size={28} />
            </div>
            <div className="text-center">
              <p className="font-extrabold text-slate-800 text-2xl mb-2">
                {step === GenerationStep.GENERATING_TEXT ? 'Gemini 3 Pro가 기획 중입니다' : 'Pro 1K 이미지를 렌더링 중입니다'}
              </p>
              <p className="text-slate-500 font-medium">사용자 API 키를 활용하여 더 빠르게 작업합니다.</p>
            </div>
            <div className="w-full max-w-md h-3 bg-slate-100 rounded-full overflow-hidden mt-6 shadow-inner">
              <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {(step === GenerationStep.REVIEW || step === GenerationStep.FINISHED) && result && (
          <div className="space-y-8 animate-in fade-in zoom-in-95 duration-500">
            <div className="flex flex-wrap justify-between items-center gap-4 border-b pb-6">
              <div>
                <h2 className="text-3xl font-black flex items-center gap-3 text-slate-800"><PencilLine className="text-blue-500" size={32} /> {step === GenerationStep.REVIEW ? '기획안 리모델링' : '최종 시사'}</h2>
                <p className="text-slate-500 font-medium">Pro 모델이 생성한 정교한 대본을 확인하세요.</p>
              </div>
              <div className="flex gap-3">
                {step === GenerationStep.REVIEW ? (
                  <button onClick={startAssetGeneration} className="bg-blue-600 hover:bg-blue-700 text-white px-10 py-4 rounded-2xl font-black shadow-xl flex items-center gap-2 transition-all hover:scale-105 active:scale-95">에셋 렌더링 <ArrowRight size={24} /></button>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={exportVideo} disabled={isExporting} className="bg-red-600 hover:bg-red-700 text-white px-8 py-4 rounded-2xl font-black shadow-xl flex items-center gap-2 disabled:opacity-50 transition-all active:scale-95">
                      {isExporting ? <Loader2 size={24} className="animate-spin" /> : <Film size={24} />} 영상 추출 (.webm)
                    </button>
                    <button onClick={() => setStep(GenerationStep.IDLE)} className="bg-slate-100 text-slate-700 px-6 py-4 rounded-2xl font-bold hover:bg-slate-200 transition-all">다시 만들기</button>
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
              <div className="space-y-8">
                <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100 space-y-6 shadow-sm">
                   <div className="flex items-center justify-between">
                    <h3 className="text-xl font-black flex items-center gap-2 text-slate-700"><FileText className="text-blue-500" /> 대본 마스터</h3>
                    {step === GenerationStep.FINISHED && (
                      <button disabled={isRegenerating.audio} onClick={regenerateAudio} className="text-sm font-black px-4 py-2 bg-blue-600 text-white rounded-xl shadow-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 transition-all active:scale-95">
                        {isRegenerating.audio ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />} 오디오 업데이트
                      </button>
                    )}
                  </div>
                  <div className="space-y-4">
                    <div>
                      <span className="text-xs font-black text-blue-600 uppercase tracking-widest ml-1">Hook</span>
                      <textarea className="w-full p-4 mt-1 bg-white border border-slate-200 rounded-2xl h-20 outline-none focus:ring-4 focus:ring-blue-100 transition-all font-medium text-slate-700" value={result.script.hook} onChange={(e) => handleEditResult('script.hook', e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Body</span>
                      <textarea className="w-full p-4 mt-1 bg-white border border-slate-200 rounded-2xl h-32 outline-none focus:ring-4 focus:ring-blue-100 transition-all font-medium text-slate-700" value={result.script.body} onChange={(e) => handleEditResult('script.body', e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Outro</span>
                      <textarea className="w-full p-4 mt-1 bg-white border border-slate-200 rounded-2xl h-20 outline-none focus:ring-4 focus:ring-blue-100 transition-all font-medium text-slate-700" value={result.script.outro} onChange={(e) => handleEditResult('script.outro', e.target.value)} />
                    </div>
                  </div>
                </div>

                <div className="bg-purple-50 p-6 rounded-3xl border border-purple-100 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-black flex items-center gap-2 text-purple-700"><Music size={18} /> 배경음악</h3>
                    <label className="cursor-pointer bg-purple-600 text-white px-4 py-2 rounded-xl text-xs font-black flex items-center gap-2 shadow-lg hover:bg-purple-700 transition-all">
                      <Upload size={14} /> BGM 업로드
                      <input type="file" accept="audio/*" onChange={handleBgmUpload} className="hidden" />
                    </label>
                  </div>
                  {assets.find(a => a.type === 'bgm') && (
                    <audio src={assets.find(a => a.type === 'bgm')?.data} controls className="w-full h-8 opacity-70" />
                  )}
                </div>

                {step === GenerationStep.FINISHED && (
                  <div className="bg-slate-900 p-8 rounded-[40px] shadow-2xl relative overflow-hidden group border border-slate-800">
                    <h3 className="text-xl font-black flex items-center gap-2 text-white mb-6"><Video size={20} className="text-red-500" /> 쇼츠 프리뷰 (Pro 1K 렌더링)</h3>
                    <div className="relative mx-auto bg-black rounded-3xl overflow-hidden shadow-2xl border border-white/10" style={{ maxWidth: '360px', aspectRatio: aspectRatio.replace(':', '/') }}>
                      <canvas ref={canvasRef} className="w-full h-full object-contain" />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-all duration-300">
                        <button onClick={handleTogglePlay} className="p-8 bg-white/20 backdrop-blur-xl rounded-full text-white shadow-2xl border border-white/30 hover:scale-110 transition-transform">
                          {isPlaying ? <Pause size={56} fill="currentColor" /> : <Play size={56} fill="currentColor" />}
                        </button>
                      </div>
                    </div>
                    <audio ref={audioRef} src={assets.find(a => a.type === 'audio')?.data} onEnded={() => setIsPlaying(false)} hidden />
                    <audio ref={bgmRef} src={assets.find(a => a.type === 'bgm')?.data} loop hidden />
                  </div>
                )}
              </div>

              <div className="space-y-6">
                <h3 className="text-2xl font-black flex items-center gap-3 text-slate-800"><ImageIcon className="text-purple-500" size={28} /> 장면별 이미지 최적화 (1K)</h3>
                <div className="space-y-4 max-h-[1000px] overflow-y-auto pr-4 custom-scrollbar">
                  {result.imagePrompts.map((p, idx) => {
                    const img = assets.find(a => a.name === `image_${idx + 1}.png`);
                    let label = "SCENE " + (idx + 1);
                    return (
                      <div key={idx} className={`flex gap-6 p-6 rounded-3xl border transition-all hover:shadow-lg ${idx === 0 || idx === result.imagePrompts.length - 1 ? 'bg-blue-50/40 border-blue-100' : 'bg-slate-50 border-slate-100'}`}>
                        <div className="flex-1 space-y-3">
                          <div className="flex justify-between items-center">
                            <span className={`text-xs font-black uppercase tracking-tighter ${idx === 0 || idx === result.imagePrompts.length - 1 ? 'text-blue-500' : 'text-slate-400'}`}>{label}</span>
                            {step === GenerationStep.FINISHED && (
                              <button disabled={isRegenerating[`image_${idx}`]} onClick={() => regenerateSingleImage(idx)} className="text-xs font-black text-purple-600 bg-purple-50 px-3 py-1.5 rounded-lg hover:bg-purple-100 transition-all disabled:opacity-50 flex items-center gap-1.5 shadow-sm active:scale-95">
                                {isRegenerating[`image_${idx}`] ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Pro 이미지 갱신
                              </button>
                            )}
                          </div>
                          <textarea className="w-full p-4 text-sm bg-white border border-slate-200 rounded-2xl h-24 outline-none focus:ring-4 focus:ring-purple-100 transition-all font-medium leading-relaxed shadow-sm" value={p} onChange={(e) => {
                            const next = [...result.imagePrompts]; next[idx] = e.target.value; setResult({...result, imagePrompts: next});
                          }} />
                        </div>
                        {img && (
                          <div className="w-32 h-32 rounded-2xl overflow-hidden bg-slate-200 border-4 border-white shadow-xl flex-shrink-0 group relative cursor-pointer">
                            <img src={img.data} className="w-full h-full object-cover transition-transform group-hover:scale-110 duration-500" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === GenerationStep.ERROR && (
          <div className="py-24 flex flex-col items-center gap-8 text-red-600 bg-red-50/50 rounded-[48px] border-2 border-red-100 animate-in zoom-in duration-300">
            <div className="p-8 bg-white rounded-full shadow-2xl">
              <AlertCircle size={72} />
            </div>
            <div className="text-center px-10 max-w-xl">
              <p className="font-black text-3xl mb-4">서비스 처리 중 오류</p>
              <div className="bg-white/80 p-6 rounded-3xl border border-red-100 text-slate-700 font-semibold shadow-inner mb-6 leading-relaxed">
                {error?.includes('429') || error?.includes('quota') 
                  ? "사용자 키의 할당량이 일시적으로 소진되었습니다. 구글 클라우드 콘솔에서 결제 설정을 확인하거나 잠시 후 다시 시도해주세요." 
                  : error}
              </div>
            </div>
            <div className="flex gap-4">
              <button onClick={() => { setStep(GenerationStep.IDLE); setError(null); }} className="bg-slate-900 hover:bg-black text-white px-12 py-5 rounded-2xl font-black shadow-2xl transition-all hover:scale-105 active:scale-95">초기 화면으로 이동</button>
              <button onClick={handleOpenKeySelector} className="bg-blue-600 hover:bg-blue-700 text-white px-12 py-5 rounded-2xl font-black shadow-2xl transition-all hover:scale-105 active:scale-95 flex items-center gap-2"><Key size={20} /> API 키 재설정</button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f8fafc; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; border: 2px solid #f8fafc; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>
      <footer className="mt-12 text-slate-400 text-sm font-bold tracking-widest uppercase flex items-center gap-2">
        <Sparkles size={14} /> Gemini AI Creative Shorts Studio v2.4 - Powered by Google
      </footer>
    </div>
  );
};

export default App;
