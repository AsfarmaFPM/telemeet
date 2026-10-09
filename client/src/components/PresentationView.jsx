import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  PenTool,
  Pointer,
  Trash2,
  Upload,
  X,
  FileText,
  Loader2,
  Monitor,
  FolderUp,
} from 'lucide-react';
import { socket, resolveMediaUrl } from '../services/socket';
import { uploadSlideBlobs } from '../services/media';
import { loadPptxFile, loadPdfFile } from '../utils/pptxLoader';
import { useLanguage } from '../i18n/LanguageContext';

const ACCEPT_TYPES = '.pdf,.pptx,.ppt,.mp4,.webm,.mov,.mkv,.avi,image/*';
const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const PDF_RE = /\.pdf$/i;
const PPTX_RE = /\.pptx?$/i;

function drawStroke(canvas, stroke) {
  if (!canvas || !stroke) return;
  const { points, color, size } = stroke;
  if (!points || points.length < 2) return;

  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = color;
  ctx.lineWidth = size || 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
  }
  ctx.stroke();
}

export function PresentationView({
  roomId,
  presentation,
  isPresenter,
  initialDrawings,
  onStopPresentation,
  onSlideChange,
  onStartScreenShare,
  onStartVideoFileShare,
}) {
  const { t, language } = useLanguage();
  const ru = language === 'ru';

  const [currentSlideIndex, setCurrentSlideIndex] = useState(presentation?.currentSlide || 0);
  const [toolMode, setToolMode] = useState('laser'); // 'laser' | 'pen' | 'none'
  const [penColor, setPenColor] = useState('#EF4444');
  const [remoteLaser, setRemoteLaser] = useState({ x: 0, y: 0, active: false });
  const [slides, setSlides] = useState(presentation?.slides || []);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [loadingText, setLoadingText] = useState('');

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const currentPathRef = useRef([]);
  // Every stroke of every slide, so going back to a slide (or joining late) shows the annotations again
  const drawingsRef = useRef({ ...(initialDrawings || {}) });

  // Sync slides and index from server
  useEffect(() => {
    if (presentation?.slides) setSlides(presentation.slides);
    if (presentation && presentation.currentSlide !== undefined) {
      setCurrentSlideIndex(presentation.currentSlide);
    }
  }, [presentation?.slides, presentation?.currentSlide]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const redrawSlide = useCallback(
    (slideIndex) => {
      clearCanvas();
      (drawingsRef.current[slideIndex] || []).forEach((stroke) => drawStroke(canvasRef.current, stroke));
    },
    [clearCanvas]
  );

  // Redraw annotations whenever the visible slide changes
  useEffect(() => {
    redrawSlide(currentSlideIndex);
  }, [currentSlideIndex, slides, redrawSlide]);

  // Socket listeners for laser pointer and drawing pen
  useEffect(() => {
    const handleLaserUpdate = ({ x, y, active }) => setRemoteLaser({ x, y, active });

    const handleStrokeReceived = ({ slideIndex, stroke }) => {
      if (!drawingsRef.current[slideIndex]) drawingsRef.current[slideIndex] = [];
      drawingsRef.current[slideIndex].push(stroke);
      if (slideIndex === currentSlideIndex) drawStroke(canvasRef.current, stroke);
    };

    const handleDrawingsCleared = ({ slideIndex }) => {
      if (slideIndex === undefined) drawingsRef.current = {};
      else drawingsRef.current[slideIndex] = [];
      if (slideIndex === undefined || slideIndex === currentSlideIndex) clearCanvas();
    };

    socket.on('presentation-laser-updated', handleLaserUpdate);
    socket.on('presentation-stroke-received', handleStrokeReceived);
    socket.on('presentation-drawings-cleared', handleDrawingsCleared);

    return () => {
      socket.off('presentation-laser-updated', handleLaserUpdate);
      socket.off('presentation-stroke-received', handleStrokeReceived);
      socket.off('presentation-drawings-cleared', handleDrawingsCleared);
    };
  }, [currentSlideIndex, clearCanvas]);

  // A NEW deck starts with a clean board (but the first render keeps the drawings sent to late joiners)
  const prevSlidesRef = useRef(presentation?.slides);
  useEffect(() => {
    if (prevSlidesRef.current !== presentation?.slides) {
      prevSlidesRef.current = presentation?.slides;
      drawingsRef.current = {};
    }
  }, [presentation?.slides]);

  // ---- Laser pointer & pen (pointer events: mouse, touch and stylus) ----
  const getNormalizedPoint = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  };

  const handlePointerMove = (e) => {
    if (!isPresenter || !containerRef.current) return;
    const point = getNormalizedPoint(e);

    if (toolMode === 'laser') {
      socket.emit('presentation-laser-move', { x: point.x * 100, y: point.y * 100, active: true });
    }

    if (toolMode === 'pen' && isDrawingRef.current) {
      const prev = currentPathRef.current[currentPathRef.current.length - 1];
      currentPathRef.current.push(point);
      if (prev) {
        drawStroke(canvasRef.current, { points: [prev, point], color: penColor, size: 3 });
      }
    }
  };

  const endDrawing = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    if (currentPathRef.current.length > 1) {
      const stroke = { points: currentPathRef.current, color: penColor, size: 3 };
      if (!drawingsRef.current[currentSlideIndex]) drawingsRef.current[currentSlideIndex] = [];
      drawingsRef.current[currentSlideIndex].push(stroke);
      socket.emit('presentation-draw-stroke', { slideIndex: currentSlideIndex, stroke });
    }
    currentPathRef.current = [];
  };

  const handlePointerDown = (e) => {
    if (!isPresenter || toolMode !== 'pen' || !containerRef.current) return;
    isDrawingRef.current = true;
    currentPathRef.current = [getNormalizedPoint(e)];
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not critical
    }
  };

  const handlePointerLeave = () => {
    if (isPresenter && toolMode === 'laser') {
      socket.emit('presentation-laser-move', { x: 0, y: 0, active: false });
    }
  };

  // ---- Slide navigation ----
  const goToSlide = useCallback(
    (index) => {
      if (!isPresenter) return;
      const clamped = Math.min(Math.max(index, 0), Math.max(slides.length - 1, 0));
      if (clamped === currentSlideIndex) return;
      setCurrentSlideIndex(clamped);
      onSlideChange(clamped);
    },
    [isPresenter, slides.length, currentSlideIndex, onSlideChange]
  );

  const prevSlide = () => goToSlide(currentSlideIndex - 1);
  const nextSlide = () => goToSlide(currentSlideIndex + 1);

  // Keyboard: arrows / PageUp / PageDown / Space (but never while typing in the chat)
  useEffect(() => {
    if (!isPresenter) return undefined;
    const onKeyDown = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) {
        e.preventDefault();
        goToSlide(currentSlideIndex + 1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        goToSlide(currentSlideIndex - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPresenter, goToSlide, currentSlideIndex]);

  // Preload neighbouring slides so flipping is instant
  useEffect(() => {
    [currentSlideIndex - 1, currentSlideIndex + 1].forEach((i) => {
      const src = slides[i]?.mediaSrc;
      if (src) new Image().src = resolveMediaUrl(src);
    });
  }, [currentSlideIndex, slides]);

  const clearCurrentDrawings = () => {
    drawingsRef.current[currentSlideIndex] = [];
    clearCanvas();
    socket.emit('presentation-clear-drawings', { slideIndex: currentSlideIndex });
  };

  // ---- File upload (PDF, PPTX, images, video) ----
  const handleUploadFiles = async (e) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = ''; // so the very same file can be chosen again (the old code never reset the toolbar input)
    if (files.length === 0 || !isPresenter) return;

    const videos = files.filter((f) => VIDEO_RE.test(f.name) || f.type.startsWith('video/'));
    const docs = files.filter((f) => PDF_RE.test(f.name) || PPTX_RE.test(f.name) || IMAGE_RE.test(f.name) || f.type.startsWith('image/'));
    const unsupported = files.filter((f) => !videos.includes(f) && !docs.includes(f));

    if (unsupported.length > 0) {
      alert(t.presentationUnsupportedFile(unsupported.map((f) => f.name).join(', ')));
      if (docs.length === 0 && videos.length === 0) return;
    }

    // Video is streamed live over WebRTC (everybody sees the same frame and hears the sound),
    // it is not packed into slides.
    if (docs.length === 0 && videos.length > 0 && onStartVideoFileShare) {
      const started = await onStartVideoFileShare(videos[0]);
      if (started) onStopPresentation();
      return;
    }
    if (docs.length === 0) return;

    setIsLoadingFile(true);
    try {
      const allSlides = [];

      for (const file of docs) {
        if (PDF_RE.test(file.name)) {
          const pdfSlides = await loadPdfFile(file, (page, total) =>
            setLoadingText(ru ? `Рендеринг PDF: ${page}/${total}` : `PDF слайдлар тайёрланмоқда: ${page}/${total}`)
          );
          allSlides.push(...pdfSlides);
        } else if (PPTX_RE.test(file.name)) {
          setLoadingText(ru ? `Чтение PowerPoint: ${file.name}...` : `PowerPoint ўқилмоқда: ${file.name}...`);
          allSlides.push(...(await loadPptxFile(file)));
        } else {
          allSlides.push({
            id: `img-${Date.now()}-${allSlides.length}`,
            title: file.name,
            subtitle: `${ru ? 'Слайд' : 'Слайд'} ${allSlides.length + 1}`,
            mediaType: 'image',
            mediaBlob: file,
            bg: 'from-gray-950 to-black',
          });
        }
      }

      if (allSlides.length === 0) throw new Error(ru ? 'Нет слайдов' : 'Слайдлар топилмади');
      allSlides.forEach((slide, i) => {
        slide.slideIndex = i;
      });

      // Upload pictures over HTTP: only small urls go through the socket
      const uploaded = await uploadSlideBlobs(roomId, allSlides, (done, total) =>
        setLoadingText(ru ? `Загрузка на сервер: ${done}/${total}` : `Серверга юкланмоқда: ${done}/${total}`)
      );

      // Show it locally right away, then broadcast and wait for the server's confirmation
      drawingsRef.current = {};
      setSlides(uploaded);
      setCurrentSlideIndex(0);

      socket.timeout(15000).emit(
        'presentation-update-deck',
        {
          presentation: {
            title: docs[0].name,
            totalSlides: uploaded.length,
            currentSlide: 0,
            slides: uploaded,
          },
        },
        (err, res) => {
          if (err || !res?.ok) {
            console.error('presentation-update-deck failed:', err || res);
            alert(res?.reason === 'too-large' ? t.presentationTooLarge : t.connectionLost);
          }
        }
      );
    } catch (err) {
      console.error('Failed to load slides file:', err);
      alert((ru ? 'Ошибка загрузки файла: ' : 'Файлни юклашда хатолик: ') + (err.message || ''));
    } finally {
      setIsLoadingFile(false);
      setLoadingText('');
    }
  };

  const currentSlide = slides[currentSlideIndex];
  const cursorClass = isPresenter && toolMode !== 'none' ? 'cursor-crosshair' : 'cursor-default';

  // 1a. Nothing uploaded yet - viewers just wait
  if ((!slides || slides.length === 0) && !isPresenter) {
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-center gap-4 bg-[#0f1115] rounded-2xl border border-gray-800 shadow-2xl p-6 select-none">
        <Loader2 className="w-10 h-10 text-orange-500 animate-spin" />
        <p className="text-sm font-semibold text-gray-200 text-center">
          {t.presentationWaiting(presentation?.presenterName || t.hostBadge)}
        </p>
      </div>
    );
  }

  // 1b. Presenter: no slides yet, show the options screen
  if (!slides || slides.length === 0) {
    return (
      <div className="relative w-full h-full flex flex-col bg-[#0f1115] rounded-2xl overflow-hidden border border-gray-800 shadow-2xl p-6 select-none">
        {/* Top Header */}
        <div className="flex items-center justify-between pb-4 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-orange-500/20 text-orange-400 flex items-center justify-center">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                {ru ? 'Демонстрация Презентации и Слайдов' : 'Презентация ва Слайдлар Намойиши'}
              </h2>
              <p className="text-xs text-gray-400">
                {ru ? 'Выберите наиболее удобный способ показа' : 'Қулай намойиш усулини танланг'}
              </p>
            </div>
          </div>

          <button
            onClick={onStopPresentation}
            className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
            title={t.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Presentation Launchpad Cards */}
        <div className="flex-1 flex flex-col items-center justify-center p-4 max-w-3xl mx-auto w-full overflow-y-auto">
          {isLoadingFile ? (
            <div className="flex flex-col items-center justify-center gap-4 text-center">
              <div className="w-14 h-14 rounded-2xl bg-orange-600/20 text-orange-500 flex items-center justify-center animate-spin">
                <Loader2 className="w-8 h-8" />
              </div>
              <p className="text-sm font-bold text-white">
                {loadingText || (ru ? 'Обработка файлов...' : 'Файллар қайта ишланмоқда...')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 w-full">
              {/* Option 1: Live PowerPoint Screen Share (The Gold Standard) */}
              <div className="bg-gradient-to-br from-orange-950/40 via-gray-900 to-black rounded-2xl p-5 border border-orange-500/40 hover:border-orange-500 flex flex-col justify-between shadow-xl transition group">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="w-10 h-10 rounded-xl bg-orange-600 text-white flex items-center justify-center shadow-lg shadow-orange-600/30">
                      <Monitor className="w-5 h-5" />
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 text-[10px] font-bold uppercase tracking-wider border border-orange-500/30">
                      {ru ? 'Рекомендуется' : 'Тавсия этилади'}
                    </span>
                  </div>

                  <h3 className="text-base font-bold text-white group-hover:text-orange-400 transition">
                    {ru ? 'Показ окна PowerPoint' : 'PowerPoint дастурини экранга узатиш'}
                  </h3>

                  <p className="text-xs text-gray-300 mt-2 leading-relaxed">
                    {ru
                      ? 'Запустите показ слайдов в PowerPoint (клавиша F5) и поделитесь экраном. Сохранятся 100% все эффекты, анимации, шрифты и исходный дизайн.'
                      : 'PowerPoint дастурида F5 тугмасини босинг ва экранни намойиш қилинг. Барча анимациялар, жадваллар, шрифтлар 100% асл сифатда кўринади.'}
                  </p>
                </div>

                <button
                  onClick={async () => {
                    // Start sharing first; only when it really started close the empty presentation
                    const started = await onStartScreenShare();
                    if (started) onStopPresentation();
                  }}
                  className="mt-5 w-full py-2.5 px-4 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs shadow-md shadow-orange-600/20 transition flex items-center justify-center gap-2"
                >
                  <Monitor className="w-4 h-4" />
                  <span>{t.screenShareStart}</span>
                </button>
              </div>

              {/* Option 2: Upload Presentation or PDF/Images */}
              <div className="bg-gradient-to-br from-blue-950/40 via-gray-900 to-black rounded-2xl p-5 border border-blue-500/40 hover:border-blue-500 flex flex-col justify-between shadow-xl transition group">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/30">
                      <FolderUp className="w-5 h-5" />
                    </div>
                    <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 text-[10px] font-bold uppercase tracking-wider border border-blue-500/30">
                      PDF • PPTX • {ru ? 'Изображения' : 'Расм'} • {ru ? 'Видео' : 'Видео'}
                    </span>
                  </div>

                  <h3 className="text-base font-bold text-white group-hover:text-blue-400 transition">
                    {ru ? 'Загрузить файл презентации' : 'Презентация файлини юклаш'}
                  </h3>

                  <p className="text-xs text-gray-300 mt-2 leading-relaxed">
                    {ru
                      ? 'Загрузите PDF, PowerPoint (.pptx), изображения слайдов или видео. Страницы переключаются синхронно для всех. Для PPTX показываются текст и картинки; для точного вида сохраните презентацию как PDF.'
                      : 'PDF, PowerPoint (.pptx), слайд расмлари ёки видеони юкланг. Слайдлар барча учун синхрон намойиш этилади. PPTX да матн ва расмлар кўринади; аниқ кўриниш учун презентацияни PDF қилиб сақланг.'}
                  </p>
                </div>

                <label className="mt-5 w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md shadow-blue-600/20 transition flex items-center justify-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" />
                  <span>{ru ? 'Выбрать файл с компьютера' : 'Компьютердан файлни танлаш'}</span>
                  <input type="file" multiple accept={ACCEPT_TYPES} onChange={handleUploadFiles} className="hidden" />
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // 2. Main Presentation Slides View (When slides are loaded)
  return (
    <div className="relative w-full h-full flex flex-col bg-[#0b0c0e] rounded-2xl overflow-hidden border border-gray-800 shadow-2xl select-none">
      {/* Top Bar Info & Tools */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#141619] border-b border-gray-800/80 text-xs shrink-0">
        <div className="flex items-center gap-3">
          <span className="px-2.5 py-0.5 rounded-lg bg-orange-600/30 text-orange-400 font-bold border border-orange-500/30">
            {isPresenter ? t.youArePresenting : t.presenterName(presentation?.presenterName || t.hostBadge)}
          </span>
          <span className="text-gray-300 font-medium truncate max-w-xs sm:max-w-md">
            {currentSlide?.title || presentation?.title || ''}
          </span>
        </div>

        {/* Presenter Toolbar */}
        <div className="flex items-center gap-2">
          {isPresenter && (
            <>
              {/* Laser Pointer Mode */}
              <button
                onClick={() => setToolMode(toolMode === 'laser' ? 'none' : 'laser')}
                className={`p-1.5 rounded-lg border text-xs flex items-center gap-1.5 transition ${
                  toolMode === 'laser'
                    ? 'bg-red-600/20 border-red-500 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.3)]'
                    : 'bg-[#1e2024] border-gray-700 text-gray-300 hover:bg-gray-700'
                }`}
                title={t.laserTool}
              >
                <Pointer className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t.laserTool}</span>
              </button>

              {/* Pen Annotation Mode */}
              <button
                onClick={() => setToolMode(toolMode === 'pen' ? 'none' : 'pen')}
                className={`p-1.5 rounded-lg border text-xs flex items-center gap-1.5 transition ${
                  toolMode === 'pen'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.3)]'
                    : 'bg-[#1e2024] border-gray-700 text-gray-300 hover:bg-gray-700'
                }`}
                title={t.penTool}
              >
                <PenTool className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t.penTool}</span>
              </button>

              {/* Color Picker for Pen */}
              {toolMode === 'pen' && (
                <div className="flex items-center gap-1 bg-[#1e2024] p-1 rounded-lg border border-gray-700">
                  {['#EF4444', '#3B82F6', '#10B981', '#FBBF24'].map((color) => (
                    <button
                      key={color}
                      onClick={() => setPenColor(color)}
                      className={`w-4 h-4 rounded-full transition-transform ${
                        penColor === color ? 'scale-125 ring-2 ring-white' : 'opacity-80'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              )}

              {/* Clear Annotations */}
              <button
                onClick={clearCurrentDrawings}
                className="p-1.5 rounded-lg bg-[#1e2024] border border-gray-700 hover:bg-gray-700 text-gray-400 hover:text-white transition"
                title={t.clearDrawings}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              {/* Upload New Files */}
              <label
                className="p-1.5 rounded-lg bg-[#1e2024] border border-gray-700 hover:bg-gray-700 text-gray-300 cursor-pointer transition flex items-center gap-1.5"
                title="PDF, PowerPoint (.pptx), Расмлар юклаш"
              >
                {isLoadingFile ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-400" />
                ) : (
                  <Upload className="w-3.5 h-3.5 text-orange-400" />
                )}
                <span className="hidden sm:inline font-medium">
                  {isLoadingFile ? loadingText || t.uploading : ru ? 'Сменить файл' : 'Бошқа файл'}
                </span>
                <input
                  type="file"
                  multiple
                  accept={ACCEPT_TYPES}
                  onChange={handleUploadFiles}
                  disabled={isLoadingFile}
                  className="hidden"
                />
              </label>
            </>
          )}

          {/* Stop Presentation Button (presenter, and host through the controls bar) */}
          {isPresenter && (
            <button
              onClick={onStopPresentation}
              className="px-2.5 py-1 rounded-lg bg-red-600/80 hover:bg-red-600 text-white font-medium text-xs transition flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" />
              <span>{t.stopPresentation}</span>
            </button>
          )}

          {!isPresenter && (
            <span className="text-gray-400 text-xs">
              {t.slideNumber} {currentSlideIndex + 1} / {slides.length}
            </span>
          )}
        </div>
      </div>

      {/* Main Slide Canvas Stage */}
      <div
        ref={containerRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={endDrawing}
        onPointerCancel={endDrawing}
        style={{ touchAction: isPresenter && toolMode !== 'none' ? 'none' : 'auto' }}
        className={`relative flex-1 bg-gradient-to-br ${
          currentSlide?.bg || 'from-gray-950 to-black'
        } flex items-center justify-center overflow-hidden ${cursorClass}`}
      >
        {currentSlide?.mediaType === 'image' || currentSlide?.mediaSrc ? (
          /* Image / PDF Slide (100% exact replica of the page) */
          <div className="w-full h-full flex items-center justify-center p-3 select-none pointer-events-none">
            <img
              key={currentSlide.id || currentSlideIndex}
              src={resolveMediaUrl(currentSlide.mediaSrc)}
              alt={currentSlide.title}
              className="max-h-full max-w-full object-contain rounded-lg shadow-2xl border border-white/5"
            />
          </div>
        ) : (
          /* Structured PPTX Slide Card */
          <div className="w-full h-full flex items-center justify-center p-6 select-none pointer-events-none">
            <div className="w-full max-w-3xl max-h-full overflow-hidden bg-white rounded-3xl p-8 sm:p-10 shadow-2xl text-gray-900 border border-gray-100 flex flex-col justify-center">
              <div className="text-xs font-bold text-orange-600 uppercase tracking-wider mb-2">
                {currentSlide?.subtitle || ''}
              </div>

              <h2 className="text-2xl sm:text-3xl font-black text-gray-900 mb-6 leading-tight">
                {currentSlide?.title || ''}
              </h2>

              {/* Embedded Slide Images if any */}
              {currentSlide?.images && currentSlide.images.length > 0 && (
                <div className="mb-6 flex flex-wrap gap-3 justify-center">
                  {currentSlide.images.map((imgSrc, iIdx) => (
                    <img
                      key={iIdx}
                      src={resolveMediaUrl(imgSrc)}
                      alt="Slide media"
                      className="max-h-48 rounded-xl object-contain shadow-md border border-gray-200"
                    />
                  ))}
                </div>
              )}

              {/* Bullet Lines */}
              {currentSlide?.lines && currentSlide.lines.length > 0 && (
                <div className="space-y-3">
                  {currentSlide.lines.map((line, lIdx) => (
                    <div key={lIdx} className="flex items-start gap-3 text-sm sm:text-base text-gray-700">
                      <span className="w-2 h-2 rounded-full bg-orange-600 mt-2 shrink-0" />
                      <span className="font-medium leading-relaxed">{line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Overlay Drawing Canvas */}
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className="absolute inset-0 w-full h-full pointer-events-none z-10"
        />

        {/* Synced Glowing Laser Pointer (viewers only: the presenter has the real cursor) */}
        {!isPresenter && remoteLaser.active && (
          <div
            className="absolute pointer-events-none z-20 transition-all duration-75"
            style={{
              left: `${remoteLaser.x}%`,
              top: `${remoteLaser.y}%`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="w-4 h-4 rounded-full bg-red-500 shadow-[0_0_15px_6px_rgba(239,68,68,0.9)] animate-ping" />
            <div className="w-3 h-3 rounded-full bg-white shadow-[0_0_10px_4px_rgba(239,68,68,1)] -mt-3.5 ml-0.5" />
          </div>
        )}
      </div>

      {/* Bottom Slide Navigation Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#141619] border-t border-gray-800/80 shrink-0">
        {/* Slide Counter */}
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{t.slideNumber}:</span>
          <span className="font-bold text-white">
            {currentSlideIndex + 1} / {slides.length}
          </span>
        </div>

        {/* Navigation Buttons */}
        {isPresenter ? (
          <div className="flex items-center gap-3">
            <button
              onClick={prevSlide}
              disabled={currentSlideIndex === 0}
              className="p-1.5 rounded-lg bg-[#202327] hover:bg-[#2c3036] disabled:opacity-40 disabled:cursor-not-allowed text-white transition"
              title={t.prevSlide}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {/* Quick Slide Dots */}
            <div className="flex items-center gap-1.5 max-w-xs overflow-x-auto py-1">
              {slides.map((_, i) => (
                <button
                  key={i}
                  onClick={() => goToSlide(i)}
                  className={`h-2 rounded-full transition-all shrink-0 ${
                    currentSlideIndex === i ? 'w-6 bg-orange-500' : 'w-2 bg-gray-600 hover:bg-gray-500'
                  }`}
                  title={`${i + 1} - ${t.slideNumber}`}
                />
              ))}
            </div>

            <button
              onClick={nextSlide}
              disabled={currentSlideIndex === slides.length - 1}
              className="p-1.5 rounded-lg bg-[#202327] hover:bg-[#2c3036] disabled:opacity-40 disabled:cursor-not-allowed text-white transition"
              title={t.nextSlide}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 max-w-xs overflow-x-auto">
            {slides.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all shrink-0 ${
                  currentSlideIndex === i ? 'w-5 bg-orange-500' : 'w-1.5 bg-gray-700'
                }`}
              />
            ))}
          </div>
        )}

        <div className="text-[11px] text-gray-500 hidden sm:block">
          {isPresenter ? t.slideNavigationTip : t.syncViewActive}
        </div>
      </div>
    </div>
  );
}
