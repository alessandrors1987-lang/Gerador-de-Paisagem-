import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Modality, LiveSession } from '@google/genai';
import './index.css';

// Audio helper functions for encoding microphone input
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function createBlob(data: Float32Array): { data: string; mimeType: string; } {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    // The Gemini Live API requires this specific audio format
    mimeType: 'audio/pcm;rate=16000',
  };
}

// Helper to convert data URL to File for sharing
async function dataUrlToFile(dataUrl: string, fileName: string): Promise<File> {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], fileName, { type: blob.type });
}

// Helper to convert a data URL to a more compact JPEG data URL to prevent storage quota errors
const convertDataUrlToJpeg = (dataUrl: string, quality = 0.85): Promise<string> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                // For PNGs with transparency, draw on a white background
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/jpeg', quality));
            } else {
                reject(new Error('Could not get canvas context for conversion.'));
            }
        };
        img.onerror = () => reject(new Error('Failed to load image for conversion.'));
        img.src = dataUrl;
    });
};


interface HistoryItem {
  src: string;
  prompt: string;
  style: string;
  styleReferenceImage?: string | null;
  aspectRatio: string;
  quality: 'standard' | 'high';
}

interface ImageViewerProps {
  item: HistoryItem | null;
  onClose: () => void;
  isClosing: boolean;
  onSetBackground: (item: HistoryItem) => void;
  onShare: (item: HistoryItem) => void;
  onDownload: (item: HistoryItem) => void;
  onRegenerate: (item: HistoryItem) => void;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ item, onClose, isClosing, onSetBackground, onShare, onDownload, onRegenerate }) => {
  if (!item) return null;

  const handleContentClick = (e: React.MouseEvent) => {
      e.stopPropagation();
  };

  return (
    <div className={`history-overlay image-viewer-overlay ${isClosing ? 'fade-out' : ''}`} onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="viewer-prompt">
      <div className="viewer-content" onClick={handleContentClick}>
        <button onClick={onClose} className="close-viewer-button" aria-label="Fechar visualizador">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <div className="viewer-image-container">
          <img src={item.src.replace(/^url\(["']?/, '').replace(/["']?\)$/, '')} alt={item.prompt} />
        </div>
        <div className="viewer-details">
          <p id="viewer-prompt" className="viewer-prompt">{item.prompt}</p>
          <div className="viewer-actions">
             <button onClick={() => onSetBackground(item)} className="paint-action-button primary">Usar como Fundo</button>
             <button onClick={() => onRegenerate(item)} className="paint-action-button">Regenerar</button>
             <button onClick={() => onShare(item)} className="paint-action-button">Compartilhar</button>
             <button onClick={() => onDownload(item)} className="paint-action-button">Baixar</button>
          </div>
        </div>
      </div>
    </div>
  );
};


interface PaintCanvasProps {
  onClose: () => void;
  onGenerate: (imageDataUrl: string) => void;
  isClosing: boolean;
}

const PaintCanvas: React.FC<PaintCanvasProps> = ({ onClose, onGenerate, isClosing }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushColor, setBrushColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(10);
  
  const colors = ['#000000', '#ff3838', '#38a1ff', '#38ff6c', '#fff838', '#FFFFFF']; // Black, Red, Blue, Green, Yellow, White (Eraser)

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Adjust for device pixel ratio for sharper drawing
    const scale = window.devicePixelRatio;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width * scale;
    canvas.height = height * scale;

    const context = canvas.getContext('2d');
    if (!context) return;
    
    context.scale(scale, scale);
    context.lineCap = 'round';
    context.strokeStyle = brushColor;
    context.lineWidth = brushSize;
    contextRef.current = context;
  }, []);

  useEffect(() => {
    if (contextRef.current) {
      contextRef.current.strokeStyle = brushColor;
      contextRef.current.lineWidth = brushSize;
    }
  }, [brushColor, brushSize]);
  
  const startDrawing = ({ nativeEvent }: React.MouseEvent<HTMLCanvasElement>) => {
    const { offsetX, offsetY } = nativeEvent;
    contextRef.current?.beginPath();
    contextRef.current?.moveTo(offsetX, offsetY);
    setIsDrawing(true);
  };

  const finishDrawing = () => {
    contextRef.current?.closePath();
    setIsDrawing(false);
  };

  const draw = ({ nativeEvent }: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const { offsetX, offsetY } = nativeEvent;
    contextRef.current?.lineTo(offsetX, offsetY);
    contextRef.current?.stroke();
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const context = contextRef.current;
    if (canvas && context) {
      // Use canvas dimensions without scaling for clearing
      context.clearRect(0, 0, canvas.width / window.devicePixelRatio, canvas.height / window.devicePixelRatio);
    }
  };

  const handleGenerateClick = () => {
    const canvas = canvasRef.current;
    if (canvas) {
        // Create a temporary canvas to draw a white background, ensuring no transparency
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        if(tempCtx){
            tempCtx.fillStyle = '#FFFFFF';
            tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
            tempCtx.drawImage(canvas, 0, 0);
            const imageDataUrl = tempCanvas.toDataURL('image/jpeg', 0.9);
            onGenerate(imageDataUrl);
        }
    }
  };

  return (
    <div className={`history-overlay ${isClosing ? 'fade-out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="paint-title">
      <div className="paint-content">
        <div className="history-header">
          <h2 id="paint-title">Modo de Pintura</h2>
           <button onClick={onClose} className="close-history-button" aria-label="Fechar modo de pintura">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
           </button>
        </div>
        <div className="paint-toolbar">
          <div className="paint-tool">
            <label htmlFor="brushSize">Tamanho:</label>
            <input 
              type="range" 
              id="brushSize" 
              min="2" 
              max="50" 
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
          </div>
          <div className="paint-tool">
             <label>Cor:</label>
             <div className="color-palette">
                {colors.map(color => (
                    <button 
                        key={color} 
                        className={`color-swatch ${brushColor === color ? 'active' : ''}`}
                        style={{ backgroundColor: color }}
                        onClick={() => setBrushColor(color)}
                        aria-label={`Selecionar cor ${color === '#FFFFFF' ? 'Borracha' : color}`}
                    />
                ))}
             </div>
          </div>
        </div>
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseUp={finishDrawing}
          onMouseOut={finishDrawing}
          onMouseMove={draw}
          className="paint-canvas"
        />
        <div className="paint-actions">
            <button className="paint-action-button" onClick={clearCanvas}>Limpar</button>
            <button className="paint-action-button primary" onClick={handleGenerateClick}>Gerar Paisagem</button>
        </div>
      </div>
    </div>
  );
};

interface CameraViewProps {
  onClose: () => void;
  onGenerate: (imageDataUrl: string) => void;
  isClosing: boolean;
}

const CameraView: React.FC<CameraViewProps> = ({ onClose, onGenerate, isClosing }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [error, setError] = useState<{title: string, message: string} | null>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);

  // New states for camera controls
  // Fix: The 'zoom' property is not part of the standard MediaTrackCapabilities type in TypeScript.
  // An intersection type is used to add it, ensuring type safety for zoom controls.
  const [cameraCapabilities, setCameraCapabilities] = useState<(MediaTrackCapabilities & { zoom?: { min: number; max: number; step: number; } }) | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [imageFilters, setImageFilters] = useState({
    brightness: 100,
    contrast: 100,
    saturation: 100,
  });

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };
  
  const startCamera = async () => {
    stopCamera();
    setError(null);
    setCapturedImage(null);
    setIsCameraReady(false);
    
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      streamRef.current = mediaStream;
      
      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        // Fix: Cast the result of getCapabilities() to our extended type to safely access 'zoom'.
        const capabilities = videoTrack.getCapabilities() as (MediaTrackCapabilities & { zoom?: { min: number; max: number; step: number; } });
        setCameraCapabilities(capabilities);
        if (capabilities.zoom) {
          setZoomLevel(capabilities.zoom.min);
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setIsCameraReady(true);
    } catch (err: any) {
      console.error("Error accessing camera:", err);
      setIsCameraReady(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setError({
              title: 'Permissão da Câmera Negada',
              message: 'Você precisa permitir o acesso à câmera nas configurações do seu navegador para usar este recurso. Após permitir, clique em "Tentar Novamente".'
          });
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setError({
              title: 'Nenhuma Câmera Encontrada',
              message: 'Não foi possível encontrar uma câmera no seu dispositivo. Verifique se ela está conectada e funcionando.'
          });
      } else {
          setError({
              title: 'Erro na Câmera',
              message: 'Ocorreu um erro inesperado ao tentar acessar a câmera. Tente recarregar a página ou usar um dispositivo diferente.'
          });
      }
    }
  };
  
  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  // Effect to apply zoom changes
  useEffect(() => {
    if (streamRef.current && cameraCapabilities?.zoom) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
        videoTrack.applyConstraints({ advanced: [{ zoom: zoomLevel }] })
          .catch(e => console.error("Falha ao aplicar zoom:", e));
      }
    }
  }, [zoomLevel, cameraCapabilities, isCameraReady]);

  const handleTakePicture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas && video.readyState >= 2) {
      const context = canvas.getContext('2d');
      if (context) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        setCapturedImage(dataUrl);
        stopCamera();
        setIsCameraReady(false);
        setImageFilters({ brightness: 100, contrast: 100, saturation: 100 });
      }
    }
  };

  const handleRetake = () => {
    startCamera();
  };

  const handleFilterChange = (filterName: keyof typeof imageFilters, value: string) => {
    setImageFilters(prev => ({ ...prev, [filterName]: Number(value) }));
  };

  const resetFilters = () => {
    setImageFilters({ brightness: 100, contrast: 100, saturation: 100 });
  };


  const handleUsePhoto = () => {
    if (capturedImage) {
        const img = new Image();
        img.onload = () => {
            const canvas = canvasRef.current;
            if(canvas){
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const { brightness, contrast, saturation } = imageFilters;
                    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
                    ctx.drawImage(img, 0, 0);
                    const filteredDataUrl = canvas.toDataURL('image/jpeg', 0.9);
                    onGenerate(filteredDataUrl);
                }
            }
        };
        img.src = capturedImage;
    }
  };

  return (
    <div className={`history-overlay ${isClosing ? 'fade-out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="camera-title">
      <div className="camera-content">
        <div className="history-header">
          <h2 id="camera-title">Usar Câmera</h2>
          <button onClick={onClose} className="close-history-button" aria-label="Fechar câmera">
             <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div className="camera-view-area">
          {error ? (
            <div className="camera-error-container">
              <h3 className="camera-error-title">{error.title}</h3>
              <p className="camera-error-message">{error.message}</p>
              { (error.title === 'Permissão da Câmera Negada' || error.title === 'Nenhuma Câmera Encontrada') &&
                <button onClick={startCamera} className="paint-action-button">Tentar Novamente</button>
              }
            </div>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline className="camera-video" style={{ display: capturedImage ? 'none' : 'block' }}/>
              {capturedImage && (
                <div className="camera-preview-wrapper">
                    <img src={capturedImage} alt="Captured preview" className="camera-preview" style={{ filter: `brightness(${imageFilters.brightness}%) contrast(${imageFilters.contrast}%) saturate(${imageFilters.saturation}%)` }} />
                </div>
              )}
              <canvas ref={canvasRef} style={{ display: 'none' }} />
            </>
          )}
        </div>
        
        <div className="camera-controls-container">
            {!error && (
                !capturedImage ? (
                    cameraCapabilities?.zoom && (
                        <div className="camera-zoom-control">
                            <label htmlFor="zoom">Zoom</label>
                            <input
                                type="range"
                                id="zoom"
                                min={cameraCapabilities.zoom.min}
                                max={cameraCapabilities.zoom.max}
                                step={cameraCapabilities.zoom.step}
                                value={zoomLevel}
                                onChange={(e) => setZoomLevel(Number(e.target.value))}
                                disabled={!isCameraReady}
                                aria-label="Controlar o zoom da câmera"
                            />
                        </div>
                    )
                ) : (
                    <div className="camera-filter-controls">
                        <div className="filter-slider">
                           <label htmlFor="brightness">Brilho</label>
                           <input type="range" id="brightness" min="0" max="200" value={imageFilters.brightness} onChange={(e) => handleFilterChange('brightness', e.target.value)} aria-label="Ajustar brilho"/>
                        </div>
                         <div className="filter-slider">
                           <label htmlFor="contrast">Contraste</label>
                           <input type="range" id="contrast" min="0" max="200" value={imageFilters.contrast} onChange={(e) => handleFilterChange('contrast', e.target.value)} aria-label="Ajustar contraste"/>
                        </div>
                         <div className="filter-slider">
                           <label htmlFor="saturation">Saturação</label>
                           <input type="range" id="saturation" min="0" max="200" value={imageFilters.saturation} onChange={(e) => handleFilterChange('saturation', e.target.value)} aria-label="Ajustar saturação"/>
                        </div>
                    </div>
                )
            )}
        </div>
        
        <div className="camera-actions">
          {!error && (
              !capturedImage ? (
                <button onClick={handleTakePicture} className="camera-shutter-button" aria-label="Tirar foto" disabled={!isCameraReady}>
                </button>
              ) : (
                <>
                  <button onClick={resetFilters} className="paint-action-button">Redefinir</button>
                  <button onClick={handleRetake} className="paint-action-button">Tirar Outra</button>
                  <button onClick={handleUsePhoto} className="paint-action-button primary">Usar Foto</button>
                </>
              )
          )}
        </div>
      </div>
    </div>
  );
};

interface VariationsModalProps {
  onClose: () => void;
  onSelect: (quadrantIndex: number) => void;
  imageUrl: string;
  isClosing: boolean;
}

const VariationsModal: React.FC<VariationsModalProps> = ({ onClose, onSelect, imageUrl, isClosing }) => {
  return (
    <div className={`history-overlay ${isClosing ? 'fade-out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="variations-title">
      <div className="variations-content">
        <div className="history-header">
          <h2 id="variations-title">Escolha uma Variação</h2>
          <button onClick={onClose} className="close-history-button" aria-label="Fechar variações">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div className="variations-image-container">
          {imageUrl ? (
            <>
              <img src={imageUrl} alt="Variações de imagem geradas pela IA" />
              <div className="variations-grid-overlay">
                <button onClick={() => onSelect(0)} aria-label="Selecionar variação superior esquerda"></button>
                <button onClick={() => onSelect(1)} aria-label="Selecionar variação superior direita"></button>
                <button onClick={() => onSelect(2)} aria-label="Selecionar variação inferior esquerda"></button>
                <button onClick={() => onSelect(3)} aria-label="Selecionar variação inferior direita"></button>
              </div>
            </>
          ) : <p>Carregando variações...</p>}
        </div>
      </div>
    </div>
  );
};

const famousPlaces = [
  'Monte Fuji no Japão, envolto em névoa da manhã com cerejeiras em primeiro plano.',
  'A vibrante Praia de Copacabana no Brasil, durante um pôr do sol dourado com pessoas jogando vôlei.',
  'O Grand Canyon, EUA, com sombras profundas e longas sob a intensa luz do meio-dia.',
  'As Pirâmides de Gizé no Egito, silhuetadas contra um céu crepuscular roxo e laranja.',
  'A Grande Muralha da China serpenteando por montanhas verdejantes durante uma manhã de outono.',
  'A Aurora Boreal dançando sobre uma vila de pescadores nevada na Noruega.',
  'Campos de lavanda na Provença, França, sob um céu de verão suave e nublado.',
  'Os canais de Veneza, Itália, refletindo as luzes dos edifícios em uma noite chuvosa.',
];

const randomPrompts = [
  'Um vale enevoado ao amanhecer, com os primeiros raios de sol perfurando a névoa e iluminando pinheiros altos.',
  'Uma praia bioluminescente à noite, com ondas azul-elétrico quebrando suavemente na areia escura sob um céu estrelado.',
  'Um campo de girassóis vibrantes sob um céu de verão dramático e tempestuoso, momentos antes da chuva.',
  'Montanhas majestosas cobertas de neve refletidas em um lago alpino vítreo e perfeitamente calmo, com ar frio e límpido.',
  'Uma cidade futurista com arranha-céus flutuantes e aerodinâmicos, banhada pela luz neon rosa e azul acima de um mar de nuvens.',
  'Ruínas antigas de um castelo em um penhasco, com o mar agitado e cinzento batendo nas rochas abaixo sob um céu nublado.',
  'Uma floresta de outono silenciosa, onde a luz do sol se filtra através da copa, criando um tapete brilhante de folhas vermelhas e douradas.',
  'Um vasto deserto de areia vermelha com formações rochosas imponentes, lançando longas sombras durante um pôr do sol ardente.',
  'Uma cachoeira poderosa escondida em uma selva exuberante e úmida, com um arco-íris vívido formado na névoa perpétua.',
  'Um farol solitário e robusto sendo atingido por ondas poderosas durante uma tempestade noturna, seu feixe de luz cortando a chuva.',
  'Campos de tulipas holandesas coloridas em plena floração, estendendo-se até o horizonte sob um moinho de vento e um céu primaveril claro.',
  'Uma paisagem de sonho etérea com árvores de cristal flutuantes e rios de luz estelar líquida correndo por uma terra de fantasia.',
  'Um cânion profundo e sinuoso, onde a luz do final da tarde cria um jogo de luz e sombra nas paredes rochosas texturizadas.',
  'A aurora boreal, com suas cortinas verdes e roxas, dançando vividamente sobre uma paisagem ártica congelada e silenciosa.',
  'Um tranquilo jardim zen japonês na primavera, com uma lagoa de carpas espelhada e pétalas de cerejeira caindo suavemente sobre uma ponte de madeira.'
];


const allStyles = [
  'Realista', 
  'Aquarela', 
  'Impressionista', 
  'Anime', 
  'Fantasia',
  'Desenho animado',
  'Pintura a óleo',
  'Vintage',
  'Cyberpunk',
  'Minimalista',
  'Steampunk',
  'Art Déco',
  'Surrealista',
  'Pixel Art',
  'Gótico',
  'Inspirado em Ghibli',
  'Art Nouveau',
  'Synthwave',
  'Low Poly',
  'Ukiyo-e',
  'Bauhaus',
  'Rococó',
  'Pintura holandesa'
];

const aspectRatios = ['16:9', '1:1', '4:3', '9:16', '3:4'];

// Helper to generate a unique class name for styles
const getStyleClass = (style: string) => `style-preview-${style.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

interface LoadingIndicatorProps {
  message: string;
}

const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({ message }) => {
  return (
    <div className="loading-overlay" role="status" aria-live="assertive">
      <div className="spinner"></div>
      <p className="loading-text">{message}</p>
    </div>
  );
};

const initialLandscapes = [
  // Sunset Beach: Deep purple sky, fading to orange sunset, then to a sandy shore.
  'linear-gradient(to bottom, #3b3a62 0%, #e87a5a 50%, #f9d499 100%)',
  // Tropical Forest: Canopy green fading into the darker undergrowth and earth.
  'linear-gradient(to bottom, #2d4a2b 0%, #1e361d 40%, #5e493c 100%)',
  // Northern Lights: A vibrant green aurora over a dark Nordic sky.
  'linear-gradient(to top, #1c2e4a 0%, #2b4f6b 50%, #43a047 100%)',
  // Grand Canyon: Layers of red and orange rock under a hazy sky.
  'linear-gradient(to top, #8a3b2b 0%, #c46a3a 40%, #e8a87c 100%)',
  // Misty Mountains: Hazy blue sky over layers of purple and blue mountains.
  'linear-gradient(160deg, #6b7a8f 0%, #a7b7c9 50%, #d3e0e8 100%)',
  // Lavender Fields at Dawn: Soft pink sky meeting fields of purple lavender.
  'linear-gradient(to bottom, #e3c4e3 0%, #8e7cc3 100%)',
];

const App: React.FC = () => {
  const [backgroundStyle, setBackgroundStyle] = useState<string>(initialLandscapes[0]);
  const [textPrompt, setTextPrompt] = useState<string>('');
  const [currentPrompt, setCurrentPrompt] = useState<string>('');
  const [imageStyle, setImageStyle] = useState<string>(() => {
    try {
        return localStorage.getItem('landscapeGenerator-style') || 'Realista';
    } catch (e) {
        console.error("Falha ao ler o estilo do localStorage", e);
        return 'Realista';
    }
  });
  const [styleReferenceImage, setStyleReferenceImage] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string>(() => {
    try {
        return localStorage.getItem('landscapeGenerator-aspectRatio') || '16:9';
    } catch (e) {
        console.error("Falha ao ler a proporção do localStorage", e);
        return '16:9';
    }
  });
  const [imageQuality, setImageQuality] = useState<'standard' | 'high'>(() => {
    try {
        const saved = localStorage.getItem('landscapeGenerator-quality');
        if (saved === 'standard' || saved === 'high') return saved;
        return 'standard';
    } catch (e) {
        console.error("Falha ao ler a qualidade do localStorage", e);
        return 'standard';
    }
  });
  const [isListening, setIsListening] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Descreva uma paisagem para começar');
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>(() => {
    try {
        const savedImages = localStorage.getItem('landscapeHistory');
        return savedImages ? JSON.parse(savedImages) : [];
    } catch (error) {
        console.error("Não foi possível carregar o histórico do localStorage", error);
        return [];
    }
  });
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isHistoryClosing, setIsHistoryClosing] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<string>('all');
  const [isPlacesModalOpen, setIsPlacesModalOpen] = useState(false);
  const [isPlacesModalClosing, setIsPlacesModalClosing] = useState(false);
  const [isPaintModalOpen, setIsPaintModalOpen] = useState(false);
  const [isPaintModalClosing, setIsPaintModalClosing] = useState(false);
  const [isCameraModalOpen, setIsCameraModalOpen] = useState(false);
  const [isCameraModalClosing, setIsCameraModalClosing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsClosing, setIsSettingsClosing] = useState(false);
  const [isVariationsModalOpen, setIsVariationsModalOpen] = useState(false);
  const [isVariationsModalClosing, setIsVariationsModalClosing] = useState(false);
  const [variationsImageUrl, setVariationsImageUrl] = useState<string | null>(null);
  const [isGeneratingVariations, setIsGeneratingVariations] = useState(false);
  const [draftExists, setDraftExists] = useState(false);

  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [isViewerClosing, setIsViewerClosing] = useState(false);
  const [viewedItem, setViewedItem] = useState<HistoryItem | null>(null);


  // Refs to manage API session and audio resources
  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<Promise<LiveSession> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rouletteRef = useRef<HTMLDivElement>(null);

  // Initialize the AI client and check for drafts on component mount
  useEffect(() => {
    aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    try {
        if (localStorage.getItem('landscapeGenerator-draft')) {
          setDraftExists(true);
        }
    } catch (e) {
        console.error("Falha ao verificar rascunho no localStorage", e);
    }

    // Ensure resources are released when the component unmounts
    return () => {
      stopListening();
    };
  }, []);

  // Slideshow for initial background
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setBackgroundStyle(currentStyle => {
        // Only cycle if the current background is not a user-generated image
        if (!currentStyle.startsWith('url(')) {
          const currentIndex = initialLandscapes.indexOf(currentStyle);
          // handle case where currentStyle might not be in the array, restart from 0
          const nextIndex = (currentIndex === -1) ? 0 : (currentIndex + 1) % initialLandscapes.length;
          return initialLandscapes[nextIndex];
        }
        // If it is a user background, don't change it.
        return currentStyle;
      });
    }, 7000); // 7 seconds for a more relaxed feel

    return () => clearInterval(intervalId);
  }, []); // Run only once on mount

  useEffect(() => {
     if (backgroundStyle.startsWith('url(')) {
        document.body.style.backgroundImage = backgroundStyle;
        document.body.style.backgroundColor = ''; // clear solid color
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
    } else {
        document.body.style.backgroundImage = backgroundStyle;
        document.body.style.backgroundColor = '';
    }
  }, [backgroundStyle]);

  // Save history items to localStorage whenever they change
  useEffect(() => {
    try {
        localStorage.setItem('landscapeHistory', JSON.stringify(historyItems));
    } catch (error) {
        console.error("Não foi possível salvar o histórico no localStorage", error);
    }
  }, [historyItems]);

  // Save user settings to localStorage
  useEffect(() => {
    try {
        localStorage.setItem('landscapeGenerator-style', imageStyle);
    } catch (error) {
        console.error("Não foi possível salvar o estilo no localStorage", error);
    }
  }, [imageStyle]);

  useEffect(() => {
    try {
        localStorage.setItem('landscapeGenerator-aspectRatio', aspectRatio);
    } catch (error) {
        console.error("Não foi possível salvar a proporção no localStorage", error);
    }
  }, [aspectRatio]);

  useEffect(() => {
    try {
        localStorage.setItem('landscapeGenerator-quality', imageQuality);
    } catch (error) {
        console.error("Não foi possível salvar a qualidade no localStorage", error);
    }
  }, [imageQuality]);

  // Effect to center the selected style in the roulette
  useEffect(() => {
    if (isSettingsOpen && rouletteRef.current && imageStyle) {
      // Use a timeout to allow the panel to render before scrolling
      setTimeout(() => {
        const selectedStyleElement = rouletteRef.current?.querySelector(`[data-style="${imageStyle}"]`);
        if (selectedStyleElement) {
          selectedStyleElement.scrollIntoView({
            behavior: 'smooth',
            inline: 'center',
            block: 'nearest'
          });
        }
      }, 100); // Small delay
    }
  }, [imageStyle, isSettingsOpen]);

  const handleTextPromptChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTextPrompt(event.target.value);
  }

  const generateImage = async (prompt: string, style: string, quality: 'standard' | 'high', inputImage?: {type: 'drawing' | 'photo', data: string}, styleImage?: string | null) => {
    if ((!prompt.trim() && !inputImage) || !aiRef.current) return;

    setIsGenerating(true);
    const useEffectiveQuality = (inputImage || styleImage) ? 'standard' : quality;
    const qualityText = useEffectiveQuality === 'standard' ? 'Padrão' : 'Alta';
    let reasonText = '';
    if (inputImage) reasonText = ' (Padrão para edição de imagem)';
    if (styleImage) reasonText = ' (Padrão para referência de estilo)';

    let generationDescription = `Gerando paisagem ${aspectRatio}`;
    if (styleImage) {
        generationDescription += ` com base em imagem de estilo`;
    } else {
        generationDescription += ` no estilo ${style}`;
    }
    generationDescription += ` (Qualidade: ${qualityText}${reasonText})...`;
    setStatusMessage(generationDescription);
    
    closeSettings();

    try {
      let storageFriendlyImageUrl: string | null = null;
      
      if (useEffectiveQuality === 'standard') {
        const parts: ({ text: string } | { inlineData: { mimeType: string; data: string; } })[] = [];
        let finalPrompt = '';

        if (styleImage) {
            const styleImageBase64 = styleImage.split(',')[1];
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: styleImageBase64 } });
            
            if (inputImage) {
                 finalPrompt = `A primeira imagem é uma referência de estilo. A segunda imagem é uma referência de conteúdo (${inputImage.type}). Crie uma nova imagem que combine o conteúdo da segunda imagem com o estilo da primeira. A nova imagem também deve incorporar esta descrição: "${prompt}". A proporção da imagem final deve ser ${aspectRatio}.`;
            } else {
                 finalPrompt = `Aplique o estilo visual da imagem fornecida para gerar uma nova imagem baseada na seguinte descrição: "${prompt}". A proporção da imagem final deve ser ${aspectRatio}. Dê à cena uma iluminação dramática e uma atmosfera climática evocativa.`;
            }
        } else {
            if (inputImage) {
                finalPrompt = `Usando ${inputImage.type === 'drawing' ? 'esta pintura' : 'esta foto'} como base, crie uma nova imagem de fundo de alta resolução no estilo ${style} na proporção de ${aspectRatio}. Incorpore a seguinte descrição: "${prompt}". Melhore a cena com iluminação dramática e uma atmosfera climática clara.`;
            } else {
                finalPrompt = `Crie uma imagem de fundo de alta resolução no estilo ${style}, na proporção de ${aspectRatio}. O tema é: "${prompt}". Foque em iluminação dramática, condições climáticas e hora do dia para criar uma atmosfera evocativa.`;
            }
        }
        
        if (inputImage) {
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: inputImage.data } });
        }
        
        parts.push({ text: finalPrompt });

        const response = await aiRef.current.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: { parts },
          config: {
            responseModalities: [Modality.IMAGE],
          },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData);

        if (imagePart?.inlineData) {
          const base64ImageBytes: string = imagePart.inlineData.data;
          const originalDataUrl = `data:image/png;base64,${base64ImageBytes}`;
          const jpegDataUrl = await convertDataUrlToJpeg(originalDataUrl);
          storageFriendlyImageUrl = `url(${jpegDataUrl})`;
        }
      } else {
        // High quality generation (text-to-image only)
        const fullPrompt = `Uma imagem de fundo de alta resolução e qualidade fotográfica no estilo ${style}. O tema é: "${prompt}". Preste muita atenção à iluminação dramática, condições climáticas atmosféricas e a hora do dia para criar uma cena vívida e evocativa.`;
        const response = await aiRef.current.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt: fullPrompt,
            config: {
              numberOfImages: 1,
              outputMimeType: 'image/jpeg',
              aspectRatio: aspectRatio,
            },
        });
        
        if (response.generatedImages && response.generatedImages.length > 0) {
            const base64ImageBytes: string = response.generatedImages[0].image.imageBytes;
            const jpegDataUrl = `data:image/jpeg;base64,${base64ImageBytes}`;
            storageFriendlyImageUrl = `url(${jpegDataUrl})`;
        }
      }

      if (storageFriendlyImageUrl) {
        setBackgroundStyle(storageFriendlyImageUrl);
        const newHistoryItem: HistoryItem = {
            src: storageFriendlyImageUrl,
            prompt,
            style,
            styleReferenceImage: styleImage || null,
            aspectRatio,
            quality: useEffectiveQuality
        };
        setHistoryItems(prev => [newHistoryItem, ...prev].slice(0, 20)); // Keep last 20
        setCurrentPrompt(prompt);
        setStatusMessage('Paisagem alterada!');
      } else {
        setStatusMessage('Não foi possível gerar a imagem.');
      }
    } catch (error) {
      console.error('Image generation error:', error);
      setStatusMessage('Ocorreu um erro ao gerar. Tente novamente.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTextPromptSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await generateImage(textPrompt, imageStyle, imageQuality, undefined, styleReferenceImage);
  };

  const stopListening = () => {
    if (sessionRef.current) {
      sessionRef.current.then(session => session.close());
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsListening(false);
    setStatusMessage('Descreva uma paisagem para começar');
  };

  const startListening = async () => {
    setIsListening(true);
    setStatusMessage('Pedindo permissão...');
    if (!aiRef.current) return;
    closeSettings();

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStatusMessage('Conectando...');

      let fullTranscription = '';

      sessionRef.current = aiRef.current.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          systemInstruction: "You are a voice assistant. The user will describe a scene. Acknowledge them by saying 'OK'.",
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatusMessage('Ouvindo...');
          },
          onmessage: (message) => {
             if (message.serverContent?.inputTranscription) {
                fullTranscription += message.serverContent.inputTranscription.text;
             }
            if (message.serverContent?.turnComplete) {
              stopListening();
              const finalTranscription = fullTranscription.trim();
              if (finalTranscription) {
                  generateImage(finalTranscription, imageStyle, imageQuality, undefined, styleReferenceImage);
              } else {
                  setStatusMessage('Não ouvi nada. Tente novamente.');
              }
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('API Error:', e);
            setStatusMessage('Ocorreu um erro. Tente novamente.');
            stopListening();
          },
          onclose: () => {
            // Cleanup is handled by the stopListening function
          },
        },
      });

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(streamRef.current);
      sourceNodeRef.current = source;
      const scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = scriptProcessor;

      scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
        const pcmBlob = createBlob(inputData);
        if (sessionRef.current) {
          sessionRef.current.then((session) => {
            session.sendRealtimeInput({ media: pcmBlob });
          });
        }
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

    } catch (error) {
      console.error('Failed to get microphone input:', error);
      setStatusMessage('Permissão do microfone negada.');
      setIsListening(false);
    }
  };

  const handleMicClick = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };
  
  const closeSettings = () => {
    if (!isSettingsOpen) return;
    setIsSettingsClosing(true);
    setTimeout(() => {
        setIsSettingsOpen(false);
        setIsSettingsClosing(false);
    }, 500);
  };

  const handleToggleSettings = () => {
    if (isSettingsOpen && !isSettingsClosing) {
        closeSettings();
    } else if (!isSettingsOpen) {
        setIsSettingsOpen(true);
    }
  };
  
  const closeHistory = () => {
    if (!isHistoryOpen) return;
    setIsHistoryClosing(true);
    setTimeout(() => {
        setIsHistoryOpen(false);
        setIsHistoryClosing(false);
        setHistoryFilter('all'); // Reset filter on close
    }, 300);
  };

  const handleToggleHistory = () => {
    if (isHistoryOpen && !isHistoryClosing) {
        closeHistory();
    } else if (!isHistoryOpen) {
        setIsHistoryOpen(true);
    }
  };
  
  const closePlacesModal = () => {
    if (!isPlacesModalOpen) return;
    setIsPlacesModalClosing(true);
    setTimeout(() => {
        setIsPlacesModalOpen(false);
        setIsPlacesModalClosing(false);
    }, 300);
  };
  
  const handleTogglePlacesModal = () => {
    if (isPlacesModalOpen && !isPlacesModalClosing) {
        closePlacesModal();
    } else if (!isPlacesModalOpen) {
        setIsPlacesModalOpen(true);
    }
  };
  
  const closePaintModal = () => {
    if (!isPaintModalOpen) return;
    setIsPaintModalClosing(true);
    setTimeout(() => {
        setIsPaintModalOpen(false);
        setIsPaintModalClosing(false);
    }, 300);
  };
  
  const handleTogglePaintModal = () => {
     if (!isPaintModalOpen) {
        setIsPaintModalOpen(true);
     }
  };

  const closeCameraModal = () => {
    if (!isCameraModalOpen) return;
    setIsCameraModalClosing(true);
    setTimeout(() => {
        setIsCameraModalOpen(false);
        setIsCameraModalClosing(false);
    }, 300);
  };
  
  const handleToggleCameraModal = () => {
    if (!isCameraModalOpen) {
      setIsCameraModalOpen(true);
    }
  };
  
  const closeVariationsModal = () => {
    if (!isVariationsModalOpen) return;
    setIsVariationsModalClosing(true);
    setTimeout(() => {
        setIsVariationsModalOpen(false);
        setIsVariationsModalClosing(false);
    }, 300);
  };
  

  const handlePaintGenerate = (imageDataUrl: string) => {
    closePaintModal();
    if (!imageDataUrl) return;
    const base64Data = imageDataUrl.split(',')[1];
    const prompt = textPrompt.trim() || "Uma bela paisagem inspirada nesta pintura";
    generateImage(prompt, imageStyle, imageQuality, { type: 'drawing', data: base64Data }, styleReferenceImage);
  };
  
  const handlePhotoGenerate = (imageDataUrl: string) => {
    closeCameraModal();
    if (!imageDataUrl) return;
    const base64Data = imageDataUrl.split(',')[1];
    const prompt = textPrompt.trim() || "Uma bela paisagem inspirada nesta foto";
    generateImage(prompt, imageStyle, imageQuality, { type: 'photo', data: base64Data }, styleReferenceImage);
  };

  const handleSelectPlace = async (place: string) => {
    closePlacesModal();
    setTextPrompt(place);
    await generateImage(place, imageStyle, imageQuality, undefined, styleReferenceImage);
  };

  const handleSelectFromHistory = (item: HistoryItem) => {
    openViewer(item);
  };
  
  const handleReuseSettings = (item: HistoryItem) => {
    setTextPrompt(item.prompt);
    setImageStyle(item.style);
    setAspectRatio(item.aspectRatio);
    setImageQuality(item.quality);
    setStyleReferenceImage(item.styleReferenceImage || null);
    closeHistory();
    setStatusMessage('Configurações carregadas. Ajuste e gere!');
  };

  const handleRegenerate = (item: HistoryItem) => {
    closeHistory();
    closeViewer();
    generateImage(item.prompt, item.style, item.quality, undefined, item.styleReferenceImage);
  };


  const handleGenerateVariations = async () => {
    if (!backgroundStyle.startsWith('url(') || !aiRef.current) return;

    setIsGeneratingVariations(true);
    setStatusMessage('Gerando variações criativas...');
    closeSettings();

    try {
        const currentImageUrl = backgroundStyle.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        const base64Data = currentImageUrl.split(',')[1];

        const response = await aiRef.current.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
                parts: [
                    { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
                    { text: "Create a 2x2 grid showing 4 artistic variations of the provided image, each with a different and interesting color palette. Maintain the core subject and composition. The grid should be seamless without any borders or text." }
                ]
            },
            config: {
                responseModalities: [Modality.IMAGE],
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData);

        if (imagePart?.inlineData) {
            const base64ImageBytes: string = imagePart.inlineData.data;
            const originalDataUrl = `data:image/png;base64,${base64ImageBytes}`;
            const jpegDataUrl = await convertDataUrlToJpeg(originalDataUrl);
            setVariationsImageUrl(jpegDataUrl);
            setIsVariationsModalOpen(true);
            setStatusMessage('Escolha sua variação favorita.');
        } else {
            setStatusMessage('Não foi possível gerar as variações.');
        }
    } catch (error) {
        console.error('Variation generation error:', error);
        setStatusMessage('Ocorreu um erro ao gerar variações.');
    } finally {
        setIsGeneratingVariations(false);
    }
  };

  const handleSelectVariation = (quadrantIndex: number) => {
    if (!variationsImageUrl) return;

    setStatusMessage('Aplicando sua nova paisagem...');
    const img = new Image();
    img.onload = async () => {
        const cropWidth = img.width / 2;
        const cropHeight = img.height / 2;
        
        const sx = (quadrantIndex % 2) * cropWidth;
        const sy = Math.floor(quadrantIndex / 2) * cropHeight;

        const canvas = document.createElement('canvas');
        canvas.width = cropWidth;
        canvas.height = cropHeight;
        const ctx = canvas.getContext('2d');
        
        if (ctx) {
            ctx.drawImage(img, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
            const newDataUrl = canvas.toDataURL('image/jpeg', 0.9);
            const storageFriendlyImageUrl = `url(${newDataUrl})`;

            const newPrompt = `Variação de "${currentPrompt}"`;
            
            const newHistoryItem: HistoryItem = {
              src: storageFriendlyImageUrl,
              prompt: newPrompt,
              style: imageStyle,
              styleReferenceImage: styleReferenceImage,
              aspectRatio: aspectRatio, // Variations from a grid keep the ratio
              quality: 'standard' // Variations are always standard
            };

            setBackgroundStyle(storageFriendlyImageUrl);
            setHistoryItems(prev => [newHistoryItem, ...prev].slice(0, 20));
            setCurrentPrompt(newPrompt);
            setStatusMessage('Paisagem alterada com a variação!');
        } else {
            setStatusMessage('Erro ao processar a imagem.');
        }
    };
    img.onerror = () => {
          setStatusMessage('Erro ao carregar a imagem para processamento.');
    };
    img.src = variationsImageUrl;
    closeVariationsModal();
    setVariationsImageUrl(null);
  };

  const handleDownloadImage = (item: HistoryItem) => {
    const link = document.createElement('a');
    const imageUrl = item.src.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    link.href = imageUrl;
    const filename = item.prompt.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').slice(0, 50) || 'paisagem-gerada';
    link.download = `${filename}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleShareImage = async (item: HistoryItem) => {
    setStatusMessage('Preparando para compartilhar...');
    try {
        const imageUrl = item.src.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        const filename = item.prompt.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').slice(0, 50) || 'paisagem-gerada';
        const file = await dataUrlToFile(imageUrl, `${filename}.png`);

        if (navigator.share && navigator.canShare({ files: [file] })) {
            await navigator.share({
                files: [file],
                title: 'Paisagem Gerada com IA',
                text: `Confira esta paisagem que gerei: ${item.prompt}`,
            });
            setStatusMessage('Paisagem compartilhada com sucesso!');
        } else {
            navigator.clipboard.writeText(item.prompt);
            alert('O compartilhamento de imagens não é suportado neste navegador. O prompt foi copiado para a sua área de transferência!');
            setStatusMessage('Prompt copiado para a área de transferência!');
        }
    } catch (error: any) {
        if (error.name !== 'AbortError') {
            console.error('Sharing failed:', error);
            setStatusMessage('Ocorreu um erro ao compartilhar.');
        } else {
            setStatusMessage('Compartilhamento cancelado.');
        }
    }
  };

  const handleSaveDraft = () => {
    const draft = {
      textPrompt,
      imageStyle,
      aspectRatio,
      imageQuality,
      backgroundStyle,
      styleReferenceImage,
    };
    try {
      localStorage.setItem('landscapeGenerator-draft', JSON.stringify(draft));
      setDraftExists(true);
      setStatusMessage('Rascunho salvo com sucesso!');
    } catch (error) {
      console.error("Não foi possível salvar o rascunho", error);
      setStatusMessage('Erro ao salvar o rascunho.');
    }
  };

  const handleLoadDraft = () => {
    try {
      const savedDraft = localStorage.getItem('landscapeGenerator-draft');
      if (savedDraft) {
        const draft = JSON.parse(savedDraft);
        setTextPrompt(draft.textPrompt || '');
        setImageStyle(draft.imageStyle || 'Realista');
        setAspectRatio(draft.aspectRatio || '16:9');
        setImageQuality(draft.imageQuality || 'standard');
        setBackgroundStyle(draft.backgroundStyle || initialLandscapes[0]);
        setStyleReferenceImage(draft.styleReferenceImage || null);
        setStatusMessage('Rascunho carregado com sucesso!');
        closeSettings();
      }
    } catch (error) {
      console.error("Não foi possível carregar o rascunho", error);
      setStatusMessage('Erro ao carregar o rascunho.');
    }
  };

  const handleCustomStyleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImageStyle(e.target.value);
    if (styleReferenceImage) {
        setStyleReferenceImage(null);
    }
  };

  const handleStyleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            const dataUrl = loadEvent.target?.result as string;
            convertDataUrlToJpeg(dataUrl).then(jpegDataUrl => {
                setStyleReferenceImage(jpegDataUrl);
                setImageStyle('Estilo de Referência');
            });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    }
  };

  const handleClearStyleImage = () => {
    setStyleReferenceImage(null);
    if (imageStyle === 'Estilo de Referência') {
        setImageStyle('Realista');
    }
  };

  const openViewer = (item: HistoryItem) => {
    setViewedItem(item);
    setIsViewerOpen(true);
  };

  const closeViewer = () => {
    if (!isViewerOpen) return;
    setIsViewerClosing(true);
    setTimeout(() => {
        setIsViewerOpen(false);
        setIsViewerClosing(false);
        setViewedItem(null);
    }, 300);
  };

  const handleSetBackgroundFromViewer = (item: HistoryItem) => {
    setBackgroundStyle(item.src);
    setCurrentPrompt(item.prompt);
    setStatusMessage(`Paisagem alterada para: "${item.prompt}"`);
    closeViewer();
  };
  
  const handleRandomPrompt = () => {
    const randomIndex = Math.floor(Math.random() * randomPrompts.length);
    setTextPrompt(randomPrompts[randomIndex]);
  };

  const filteredHistory = historyItems.filter(item => historyFilter === 'all' || item.style === historyFilter);

  return (
    <>
      {(isGenerating || isGeneratingVariations) && <LoadingIndicator message={statusMessage} />}
      <h1 className="app-title">Gerador de Paisagem 🏞️</h1>
      
      {isSettingsOpen && (
        <div className={`settings-panel ${isSettingsClosing ? 'fade-out' : ''}`}>
          <div className="settings-content">
            <div className="settings-group">
                <div className="palette-section">
                    <label>Estilo</label>
                    <div className="style-roulette-wrapper">
                        <div className="style-roulette-pointer" />
                        <div className="style-roulette-container" ref={rouletteRef}>
                            <div className="style-roulette-track">
                                {allStyles.map(style => (
                                <button
                                    key={style}
                                    type="button"
                                    className={`style-card ${imageStyle === style ? 'active' : ''}`}
                                    onClick={() => {
                                        setImageStyle(style);
                                        setStyleReferenceImage(null);
                                    }}
                                    disabled={isGenerating || isListening}
                                    aria-label={`Selecionar estilo: ${style}`}
                                    aria-pressed={imageStyle === style}
                                    data-style={style}
                                >
                                    <div className={`style-card-preview ${getStyleClass(style)}`}></div>
                                    <span className="style-card-label">{style}</span>
                                </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="settings-group">
                <div className="palette-section">
                    <label htmlFor="customStyleInput">Estilo Personalizado</label>
                    <input
                        type="text"
                        id="customStyleInput"
                        className="custom-style-input"
                        placeholder="Ex: Fantasia sombria, guache"
                        value={(styleReferenceImage || allStyles.includes(imageStyle)) ? '' : imageStyle}
                        onChange={handleCustomStyleChange}
                        disabled={isGenerating || isListening}
                    />
                    <label>Ou carregue uma referência</label>
                    <div className="style-image-uploader">
                        {styleReferenceImage ? (
                            <div className="style-image-preview">
                                <img src={styleReferenceImage} alt="Pré-visualização do estilo"/>
                                <button onClick={handleClearStyleImage} className="clear-style-image-btn" aria-label="Remover imagem de estilo">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                                </button>
                            </div>
                        ) : (
                            <label htmlFor="styleImageInput" className="style-image-label">
                                <svg xmlns="http://www.w3.org/2000/svg" height="32" viewBox="0 0 24 24" width="32" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
                                <span>Carregar Imagem</span>
                            </label>
                        )}
                        <input
                            type="file"
                            id="styleImageInput"
                            accept="image/png, image/jpeg"
                            style={{ display: 'none' }}
                            onChange={handleStyleImageUpload}
                            disabled={isGenerating || isListening}
                        />
                    </div>
                </div>
            </div>

            <div className="settings-group">
                <div className="palette-section">
                  <label>Proporção:</label>
                  <div className="aspect-ratio-buttons">
                    {aspectRatios.map(ratio => (
                      <button
                        key={ratio}
                        type="button"
                        className={`aspect-ratio-button ${aspectRatio === ratio ? 'active' : ''}`}
                        onClick={() => setAspectRatio(ratio)}
                        disabled={isGenerating || isListening}
                        aria-label={`Definir proporção para ${ratio}`}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="palette-section">
                  <label>Qualidade da Imagem:</label>
                  <div className="quality-buttons">
                     <button
                        type="button"
                        className={`quality-button ${imageQuality === 'standard' ? 'active' : ''}`}
                        onClick={() => setImageQuality('standard')}
                        disabled={isGenerating || isListening}
                      >
                        Padrão
                      </button>
                      <button
                        type="button"
                        className={`quality-button ${imageQuality === 'high' ? 'active' : ''}`}
                        onClick={() => setImageQuality('high')}
                        disabled={isGenerating || isListening || !!styleReferenceImage}
                      >
                        Alta
                      </button>
                  </div>
                </div>
                
                <div className="palette-section palette-actions">
                  <label>Ferramentas:</label>
                  <div className="tools-scroll-container">
                    <div className="tools-track">
                      <button
                        type="button"
                        className="action-button camera-button"
                        onClick={handleToggleCameraModal}
                        aria-label="Usar câmera"
                        disabled={isGenerating || isListening}
                      >
                          <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><circle cx="12" cy="12" r="3.2"/><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
                          <span>Câmera</span>
                      </button>
                      <button
                        type="button"
                        className="action-button paint-button"
                        onClick={handleTogglePaintModal}
                        aria-label="Abrir modo de pintura"
                        disabled={isGenerating || isListening}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                        <span>Pintar</span>
                      </button>
                      <button
                        type="button"
                        className="action-button explore-button"
                        onClick={handleTogglePlacesModal}
                        aria-label="Explorar lugares"
                        disabled={isGenerating || isListening}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" enableBackground="new 0 0 24 24" height="24" viewBox="0 0 24 24" width="24" fill="currentColor"><g><rect fill="none" height="24" width="24"></rect></g><g><path d="M12,2C6.48,2,2,6.48,2,12s4.48,10,10,10s10-4.48,10,10S17.52,2,12,2z M11,19.93C7.05,19.44,4,16.08,4,12 c0-0.61,0.08-1.21,0.21-1.79L9,12v1c0,1.1,0.9,2,2,2V19.93z M17.9,17.39C17.64,16.58,17,15.5,17,14v-2c0-1.1-0.9-2-2-2h-1V9 c0-1.1-0.9-2-2-2V6c0-0.55-0.45-1-1-1s-1,0.45-1,1v1H8c-1.1,0-2,0.9-2,2v2c0,1.1,0.9,2,2,2h1v1c0,1.1,0.9,2,2,2h2c0,0.55,0.45,1,1,1 C15.21,18,16.63,17.74,17.9,17.39z"></path></g></svg>
                        <span>Explorar</span>
                      </button>
                       <button
                        type="button"
                        className="action-button variations-button"
                        onClick={handleGenerateVariations}
                        aria-label="Gerar variações da imagem atual"
                        disabled={isGenerating || isListening || !backgroundStyle.startsWith('url(') || isGeneratingVariations}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M7 15H5.5v1.5H4V15H2.5v-1.5H4V12h1.5v1.5H7V15zm11.5-3.5h-13v-1h13v1zm-5 5.5H12v1.5h1.5v1.5h1.5v-1.5H16.5V17H15v-1.5zm-5-4h1.5v1.5H10V15H8.5v-1.5H7V12h1.5zm6.5 2.5h1.5v1.5h-1.5zM12 3C6.5 3 2 7.5 2 13s4.5 10 10 10 10-4.5 10-10S17.5 3 12 3zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
                        <span>Variações</span>
                      </button>
                      <button
                        type="button"
                        className="action-button history-button"
                        onClick={handleToggleHistory}
                        aria-label="Abrir histórico de gerações"
                        disabled={isGenerating || isListening || historyItems.length === 0}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8H12z"/></svg>
                        <span>Histórico</span>
                      </button>
                      <button
                        type="button"
                        className="action-button save-draft-button"
                        onClick={handleSaveDraft}
                        aria-label="Salvar rascunho"
                        disabled={isGenerating || isListening}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
                        <span>Salvar</span>
                      </button>
                      <button
                        type="button"
                        className="action-button load-draft-button"
                        onClick={handleLoadDraft}
                        aria-label="Carregar rascunho"
                        disabled={isGenerating || isListening || !draftExists}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 8v-2h-4v2H8l4 4 4-4h-2z"/></svg>
                        <span>Carregar</span>
                      </button>
                    </div>
                  </div>
                </div>
            </div>
          </div>
        </div>
      )}

      <footer className="input-bar">
         <p className="status-message" aria-live="polite">{statusMessage}</p>
        <form className="text-prompt-form" onSubmit={handleTextPromptSubmit}>
          <button
            type="button"
            className={`settings-button ${isSettingsOpen ? 'active' : ''}`}
            onClick={handleToggleSettings}
            aria-label="Abrir configurações criativas"
            aria-expanded={isSettingsOpen}
            disabled={isGenerating || isListening}
          >
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
          </button>
          <input
            type="text"
            id="textPromptInput"
            className="text-prompt-input"
            value={textPrompt}
            onChange={handleTextPromptChange}
            placeholder="Descreva uma paisagem com texto ou voz..."
            aria-label="Entrada de descrição da paisagem"
            disabled={isGenerating || isListening}
          />
          <button
            type="button"
            className="random-prompt-button"
            onClick={handleRandomPrompt}
            aria-label="Gerar prompt aleatório"
            disabled={isGenerating || isListening}
          >
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9.5 16c-.83 0-1.5-.67-1.5-1.5S8.67 13 9.5 13s1.5.67 1.5 1.5S10.33 16 9.5 16zm0-5C8.67 11 8 10.33 8 9.5S8.67 8 9.5 8s1.5.67 1.5 1.5S10.33 11 9.5 11zm5 5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
          </button>
          <button
            type="submit"
            className="submit-button"
            aria-label="Gerar paisagem"
            disabled={isGenerating || isListening || !textPrompt.trim()}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M16.172 11l-5.364-5.364 1.414-1.414L20 12l-7.778 7.778-1.414-1.414L16.172 13H4v-2z"/></svg>
          </button>
          <button
            type="button"
            className={`mic-button ${isListening ? 'listening' : ''}`}
            onClick={handleMicClick}
            aria-label={isListening ? 'Parar de ouvir' : 'Ativar entrada por voz'}
            aria-pressed={isListening}
            disabled={isGenerating}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z" />
            </svg>
          </button>
        </form>
      </footer>

      {isHistoryOpen && (
        <div className={`history-overlay ${isHistoryClosing ? 'fade-out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="history-title">
          <div className="history-content">
            <div className="history-header">
              <div className="history-title-group">
                <h2 id="history-title">Seu Histórico</h2>
                <div className="history-filter-container">
                  <label htmlFor="styleFilter">Filtrar por Estilo:</label>
                  <select 
                    id="styleFilter" 
                    value={historyFilter} 
                    onChange={(e) => setHistoryFilter(e.target.value)}
                    className="history-filter-select"
                  >
                    <option value="all">Todos os Estilos</option>
                    {allStyles.map(style => (
                        <option key={style} value={style}>{style}</option>
                    ))}
                  </select>
                </div>
              </div>
              <button onClick={closeHistory} className="close-history-button" aria-label="Fechar histórico">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            {historyItems.length > 0 ? (
              <div className="history-grid">
                {filteredHistory.length > 0 ? (
                  filteredHistory.map((item, index) => (
                    <div key={index} className="history-item">
                      <div
                        className="history-thumbnail"
                        style={{ backgroundImage: item.src }}
                        onClick={() => handleSelectFromHistory(item)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Selecionar paisagem: ${item.prompt}`}
                      >
                      </div>
                      <div className="history-item-details">
                        <p className="history-item-prompt" title={item.prompt}>{item.prompt}</p>
                        <div className="history-item-tags">
                           <span>{item.styleReferenceImage ? 'Ref. Estilo' : item.style}</span>
                          <span>{item.aspectRatio}</span>
                          <span>{item.quality}</span>
                        </div>
                      </div>
                      <div className="history-item-actions">
                          <button onClick={() => handleReuseSettings(item)} className="history-action-button" aria-label="Reusar configurações">Reusar</button>
                          <button onClick={() => handleRegenerate(item)} className="history-action-button primary" aria-label="Regenerar imagem">Regenerar</button>
                          <button onClick={() => handleShareImage(item)} className="icon-button" aria-label={`Compartilhar paisagem: ${item.prompt}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"/></svg>
                          </button>
                          <button onClick={() => handleDownloadImage(item)} className="icon-button" aria-label={`Baixar paisagem: ${item.prompt}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                          </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="history-empty-filter-message">Nenhum item encontrado para o estilo "{historyFilter}".</p>
                )}
              </div>
            ) : (
              <p>Seu histórico está vazio. Gere uma paisagem para começar!</p>
            )}
          </div>
        </div>
      )}

      {isPlacesModalOpen && (
        <div className={`history-overlay ${isPlacesModalClosing ? 'fade-out' : ''}`} role="dialog" aria-modal="true" aria-labelledby="places-title">
          <div className="history-content">
            <div className="history-header">
              <h2 id="places-title">Explore Lugares Famosos</h2>
              <button onClick={closePlacesModal} className="close-history-button" aria-label="Fechar explorador">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
            <ul className="places-list">
              {famousPlaces.map((place, index) => (
                <li key={index}>
                  <button className="place-item-button" onClick={() => handleSelectPlace(place)}>
                    {place}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      
      {isVariationsModalOpen && variationsImageUrl && (
        <VariationsModal 
          onClose={closeVariationsModal} 
          onSelect={handleSelectVariation}
          imageUrl={variationsImageUrl}
          isClosing={isVariationsModalClosing}
        />
      )}

      {isPaintModalOpen && (
        <PaintCanvas 
          onClose={closePaintModal} 
          onGenerate={handlePaintGenerate} 
          isClosing={isPaintModalClosing}
        />
      )}

      {isCameraModalOpen && (
        <CameraView 
          onClose={closeCameraModal} 
          onGenerate={handlePhotoGenerate} 
          isClosing={isCameraModalClosing}
        />
      )}

      {isViewerOpen && (
        <ImageViewer
            item={viewedItem}
            onClose={closeViewer}
            isClosing={isViewerClosing}
            onSetBackground={handleSetBackgroundFromViewer}
            onShare={handleShareImage}
            onDownload={handleDownloadImage}
            onRegenerate={handleRegenerate}
        />
      )}
    </>
  );
};

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

const root = ReactDOM.createRoot(rootEl);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);