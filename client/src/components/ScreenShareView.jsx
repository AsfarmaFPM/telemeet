import React, { useRef, useEffect, useState } from 'react';
import { Monitor, Maximize2, Minimize2, X, Loader2, Play, Pause, Volume2 } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Play / pause / seek controls, shown only to the person who shares a video FILE.
 * Everything they do is mirrored to the other participants through the captured stream.
 */
function FileShareControls({ mediaElement }) {
  const [paused, setPaused] = useState(mediaElement.paused);
  const [time, setTime] = useState(mediaElement.currentTime || 0);
  const [duration, setDuration] = useState(mediaElement.duration || 0);

  useEffect(() => {
    const sync = () => {
      setPaused(mediaElement.paused);
      setTime(mediaElement.currentTime || 0);
      setDuration(mediaElement.duration || 0);
    };
    const events = ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata'];
    events.forEach((ev) => mediaElement.addEventListener(ev, sync));
    sync();
    return () => events.forEach((ev) => mediaElement.removeEventListener(ev, sync));
  }, [mediaElement]);

  const togglePlay = () => {
    if (mediaElement.paused) {
      if (mediaElement.ended) mediaElement.currentTime = 0;
      mediaElement.play().catch(() => {});
    } else {
      mediaElement.pause();
    }
  };

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[min(560px,92%)] bg-black/80 backdrop-blur-md px-3 py-2 rounded-xl border border-white/10 text-xs text-gray-200 flex items-center gap-3 shadow-xl z-20">
      <button
        onClick={togglePlay}
        className="p-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white transition shrink-0"
      >
        {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
      </button>
      <span className="tabular-nums shrink-0">{formatTime(time)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(time, duration || 0)}
        onChange={(e) => {
          mediaElement.currentTime = Number(e.target.value);
        }}
        className="flex-1 accent-orange-500"
      />
      <span className="tabular-nums shrink-0">{formatTime(duration)}</span>
    </div>
  );
}

export function ScreenShareView({
  stream,
  sharerName,
  isSelf = false,
  mediaElement = null,
  onStopScreenShare,
}) {
  const { t } = useLanguage();
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [needsSoundTap, setNeedsSoundTap] = useState(false);

  // Attach the stream and re-trigger playback whenever a video track unmutes or is added
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;

    const attachAndPlay = () => {
      if (el.srcObject !== stream) el.srcObject = stream;
      el.play().catch(() => {
        if (!isSelf) {
          el.muted = true;
          el.play().catch(() => {});
          setNeedsSoundTap(true);
        }
      });
    };

    attachAndPlay();

    const vTracks = stream.getVideoTracks();
    vTracks.forEach((tr) => tr.addEventListener('unmute', attachAndPlay));
    stream.addEventListener('addtrack', attachAndPlay);

    return () => {
      vTracks.forEach((tr) => tr.removeEventListener('unmute', attachAndPlay));
      stream.removeEventListener('addtrack', attachAndPlay);
    };
  }, [stream, isSelf]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch((err) => console.warn(err));
    } else {
      document.exitFullscreen().catch((err) => console.warn(err));
    }
  };

  const enableSound = () => {
    if (videoRef.current) {
      videoRef.current.muted = false;
      videoRef.current.play().catch(() => {});
    }
    setNeedsSoundTap(false);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex flex-col bg-[#0d0e11] rounded-2xl overflow-hidden border border-gray-800 shadow-2xl"
    >
      {/* Top Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#16181d] border-b border-gray-800/80 text-xs z-20">
        <div className="flex items-center gap-2.5">
          <div className="p-1 rounded-lg bg-orange-500/20 text-orange-400">
            <Monitor className="w-4 h-4" />
          </div>
          <span className="font-semibold text-white">
            {isSelf ? t.youAreSharing : t.someoneIsSharing(sharerName)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg bg-[#202327] hover:bg-[#2c3036] text-gray-300 hover:text-white transition"
            title={isFullscreen ? t.exitFullscreen : t.fullscreen}
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {/* Stop Sharing Button (Only for sharer) */}
          {isSelf && (
            <button
              onClick={onStopScreenShare}
              className="px-3 py-1 rounded-lg bg-red-600/90 hover:bg-red-600 text-white font-semibold text-xs transition flex items-center gap-1.5 shadow-md shadow-red-600/30"
            >
              <X className="w-3.5 h-3.5" />
              <span>{t.stopSharingBtn}</span>
            </button>
          )}
        </div>
      </div>

      {/* Video Content */}
      <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden p-2">
        {!stream ? (
          <div className="flex flex-col items-center justify-center gap-3 text-gray-400">
            <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
            <p className="text-sm font-medium">{t.connectingScreen || 'Экран намойиши уланмоқда...'}</p>
          </div>
        ) : (
          // The same element plays picture AND sound for viewers (own preview stays muted to avoid echo)
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isSelf}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        )}

        {needsSoundTap && !isSelf && (
          <button
            onClick={enableSound}
            className="absolute top-4 right-4 z-30 flex items-center gap-2 px-3 py-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold shadow-lg"
          >
            <Volume2 className="w-4 h-4" />
            <span>{t.soundOn}</span>
          </button>
        )}

        {/* Presenter controls: video file player, or a short tip for screen sharing */}
        {isSelf && mediaElement ? (
          <FileShareControls mediaElement={mediaElement} />
        ) : (
          isSelf && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur-md px-4 py-2 rounded-xl border border-white/10 text-xs text-gray-300 flex items-center gap-2 shadow-xl z-20">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-ping" />
              <span>{t.pptxLiveTip}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
