import { useState, useEffect, useRef, useCallback } from 'react';
import { socket } from '../services/socket';
import { useLanguage } from '../i18n/LanguageContext';

// ---------------------------------------------------------------------------
// ICE configuration
// Includes public STUN + free OpenRelay TURN servers so video & screen sharing
// work reliably even across different networks, firewalls, and mobile NATs.
// ---------------------------------------------------------------------------
function buildRtcConfig() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL;
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
      username: import.meta.env.VITE_TURN_USERNAME || '',
      credential: import.meta.env.VITE_TURN_CREDENTIAL || '',
    });
  }

  return { iceServers, iceCandidatePoolSize: 4 };
}

const RTC_CONFIG = buildRtcConfig();

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: 'user',
};

export function useWebRTC() {
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;

  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState(new Map()); // socketId -> MediaStream
  const [screenStream, setScreenStream] = useState(null);
  const [sharedVideoElement, setSharedVideoElement] = useState(null); // <video> when a video FILE is being shared
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(true);
  const [isVideoOff, setIsVideoOff] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // socketId -> { pc, isInitiator, audioTransceiver, videoTransceiver, makingOffer, restarts, disconnectTimer }
  const peers = useRef(new Map());
  const pendingCandidates = useRef(new Map()); // socketId -> RTCIceCandidateInit[]

  const localStreamRef = useRef(null); // microphone + camera
  const screenStreamRef = useRef(null); // what is currently being shared (screen or video file preview)
  const screenVideoTrackRef = useRef(null);
  const mixedAudioTrackRef = useRef(null); // mic + shared audio, only while sharing with sound
  const shareCleanupRef = useRef(null);
  const stopScreenShareRef = useRef(null);
  const vadRef = useRef({ ctx: null, raf: 0, stopped: true });
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const initGenRef = useRef(0);

  // -------------------------------------------------------------------------
  // Outgoing track helpers
  // -------------------------------------------------------------------------
  const getMicTrack = () => localStreamRef.current?.getAudioTracks()[0] || null;
  const getCameraTrack = () => localStreamRef.current?.getVideoTracks()[0] || null;
  const getOutgoingAudioTrack = () => mixedAudioTrackRef.current || getMicTrack();
  const getOutgoingVideoTrack = () => screenVideoTrackRef.current || getCameraTrack();

  const sendOffer = useCallback(async (targetSocketId, options) => {
    const meta = peers.current.get(targetSocketId);
    if (!meta) return;
    const { pc } = meta;

    try {
      meta.makingOffer = true;
      const offer = await pc.createOffer(options);
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      socket.emit('signal-offer', { targetSocketId, offer: pc.localDescription });
    } catch (err) {
      console.error('[WebRTC] Error creating offer:', err);
    } finally {
      meta.makingOffer = false;
    }
  }, []);

  // Swap the track that is sent to every peer and renegotiate when needed so remote peers
  // immediately wake up their video decoder (critical when camera was off before screen sharing).
  const replaceOutgoing = useCallback(
    async (kind, track, renegotiate = false) => {
      for (const [id, meta] of peers.current.entries()) {
        const transceiver = kind === 'audio' ? meta.audioTransceiver : meta.videoTransceiver;
        if (!transceiver) continue;
        try {
          if (track) track.enabled = true;
          transceiver.direction = 'sendrecv';
          await transceiver.sender.replaceTrack(track || null);
          if (renegotiate && meta.pc.signalingState === 'stable') {
            await sendOffer(id);
          }
        } catch (err) {
          console.warn(`[WebRTC] replaceTrack(${kind}) failed for ${id}:`, err);
        }
      }
    },
    [sendOffer]
  );

  // -------------------------------------------------------------------------
  // Voice activity detection (speaking indicator)
  // -------------------------------------------------------------------------
  const stopVoiceActivity = useCallback(() => {
    const vad = vadRef.current;
    vad.stopped = true;
    if (vad.raf) cancelAnimationFrame(vad.raf);
    vad.raf = 0;
    if (vad.ctx && vad.ctx.state !== 'closed') vad.ctx.close().catch(() => {});
    vad.ctx = null;
  }, []);

  const setupVoiceActivity = useCallback(
    (stream) => {
      stopVoiceActivity();
      try {
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) return;

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioContextClass();
        audioCtx.resume?.().catch(() => {});

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.4;
        audioCtx.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);

        const vad = vadRef.current;
        vad.ctx = audioCtx;
        vad.stopped = false;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let speakingCounter = 0;

        const checkAudio = () => {
          if (vad.stopped) return;

          if (!audioTrack.enabled || audioTrack.readyState === 'ended') {
            setIsSpeaking(false);
          } else {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const average = sum / dataArray.length;

            speakingCounter = average > 18 ? Math.min(speakingCounter + 1, 8) : Math.max(speakingCounter - 1, 0);
            setIsSpeaking(speakingCounter > 2);
          }
          vad.raf = requestAnimationFrame(checkAudio);
        };

        checkAudio();
      } catch (e) {
        console.warn('Audio analyser setup failed:', e);
      }
    },
    [stopVoiceActivity]
  );

  // -------------------------------------------------------------------------
  // Local media
  // -------------------------------------------------------------------------
  const initLocalStream = useCallback(
    async (audio = true, video = true) => {
      const generation = ++initGenRef.current;
      const tryGetUserMedia = async (constraints) => {
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          console.warn('[WebRTC] getUserMedia failed for', Object.keys(constraints).join('+'), err.name);
          return null;
        }
      };

      let stream = null;
      if (navigator.mediaDevices?.getUserMedia) {
        stream = await tryGetUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });

        if (!stream) {
          const audioOnly = await tryGetUserMedia({ audio: AUDIO_CONSTRAINTS });
          const videoOnly = await tryGetUserMedia({ video: VIDEO_CONSTRAINTS });
          stream = new MediaStream([...(audioOnly?.getTracks() || []), ...(videoOnly?.getTracks() || [])]);
        }
      } else {
        console.warn('[WebRTC] mediaDevices is not available (page must be opened via https:// or localhost)');
        stream = new MediaStream();
      }

      if (generation !== initGenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return stream;
      }

      const hasAudio = stream.getAudioTracks().length > 0;
      const hasVideo = stream.getVideoTracks().length > 0;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = audio;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = video;
      });

      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsAudioMuted(!(audio && hasAudio));
      setIsVideoOff(!(video && hasVideo));

      setupVoiceActivity(stream);
      return stream;
    },
    [setupVoiceActivity]
  );

  const getMediaState = useCallback(() => {
    const mic = getMicTrack();
    const cam = getCameraTrack();
    return {
      audioEnabled: !!mic && mic.enabled,
      videoEnabled: !!cam && cam.enabled,
    };
  }, []);

  const toggleAudio = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const track = stream.getAudioTracks()[0];
    if (!track) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        const newTrack = micStream.getAudioTracks()[0];
        stream.addTrack(newTrack);
        setupVoiceActivity(stream);
        if (!mixedAudioTrackRef.current) await replaceOutgoing('audio', newTrack, true);
        setIsAudioMuted(false);
        socket.emit('toggle-media', { mediaType: 'audio', enabled: true });
      } catch (err) {
        console.error('Failed to enable microphone:', err);
      }
      return;
    }

    const nextState = !track.enabled;
    track.enabled = nextState;
    setIsAudioMuted(!nextState);
    socket.emit('toggle-media', { mediaType: 'audio', enabled: nextState });
  }, [replaceOutgoing, setupVoiceActivity]);

  const toggleVideo = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const track = stream.getVideoTracks()[0];
    if (!track) {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
        const newTrack = camStream.getVideoTracks()[0];
        stream.addTrack(newTrack);
        if (!screenVideoTrackRef.current) await replaceOutgoing('video', newTrack, true);
        setIsVideoOff(false);
        socket.emit('toggle-media', { mediaType: 'video', enabled: true });
      } catch (err) {
        console.error('Failed to enable camera:', err);
      }
      return;
    }

    const nextState = !track.enabled;
    track.enabled = nextState;
    setIsVideoOff(!nextState);
    socket.emit('toggle-media', { mediaType: 'video', enabled: nextState });
  }, [replaceOutgoing]);

  // -------------------------------------------------------------------------
  // Peer connections
  // -------------------------------------------------------------------------
  const cleanupPeer = useCallback((targetSocketId) => {
    const meta = peers.current.get(targetSocketId);
    if (meta) {
      clearTimeout(meta.disconnectTimer);
      meta.pc.onicecandidate = null;
      meta.pc.ontrack = null;
      meta.pc.onconnectionstatechange = null;
      try {
        meta.pc.close();
      } catch {
        // already closed
      }
      peers.current.delete(targetSocketId);
    }
    pendingCandidates.current.delete(targetSocketId);
    setRemoteStreams((prev) => {
      if (!prev.has(targetSocketId)) return prev;
      const updated = new Map(prev);
      updated.delete(targetSocketId);
      return updated;
    });
  }, []);

  const restartPeer = useCallback(
    (targetSocketId) => {
      const meta = peers.current.get(targetSocketId);
      if (!meta || meta.pc.signalingState === 'closed') return;

      meta.restarts = (meta.restarts || 0) + 1;
      if (meta.restarts > 4) {
        cleanupPeer(targetSocketId);
        return;
      }

      if (meta.isInitiator) {
        sendOffer(targetSocketId, { iceRestart: true });
      } else {
        socket.emit('request-renegotiation', { targetSocketId });
      }
    },
    [cleanupPeer, sendOffer]
  );

  const createPeerConnection = useCallback(
    (targetSocketId, isInitiator) => {
      const existing = peers.current.get(targetSocketId);
      if (existing) return existing;

      console.log(`[WebRTC] Creating PeerConnection with ${targetSocketId} (isInitiator=${isInitiator})`);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const meta = {
        pc,
        isInitiator,
        makingOffer: false,
        restarts: 0,
        disconnectTimer: null,
        audioTransceiver: null,
        videoTransceiver: null,
      };
      peers.current.set(targetSocketId, meta);

      const streams = localStreamRef.current ? [localStreamRef.current] : [new MediaStream()];
      meta.audioTransceiver = pc.addTransceiver(getOutgoingAudioTrack() || 'audio', { direction: 'sendrecv', streams });
      meta.videoTransceiver = pc.addTransceiver(getOutgoingVideoTrack() || 'video', { direction: 'sendrecv', streams });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('ice-candidate', { targetSocketId, candidate: event.candidate });
        }
      };

      pc.ontrack = (event) => {
        console.log(`[WebRTC] Received ${event.track.kind} track from ${targetSocketId}`);
        const track = event.track;
        const refreshStream = () => {
          setRemoteStreams((prev) => {
            if (peers.current.get(targetSocketId)?.pc !== pc) return prev;
            const current = prev.get(targetSocketId);
            const otherTracks = current ? current.getTracks().filter((tr) => tr.kind !== track.kind) : [];
            const updated = new Map(prev);
            updated.set(targetSocketId, new MediaStream([...otherTracks, track]));
            return updated;
          });
        };
        track.onunmute = refreshStream;
        refreshStream();
      };

      pc.onconnectionstatechange = () => {
        if (peers.current.get(targetSocketId)?.pc !== pc) return;
        const state = pc.connectionState;
        console.log(`[WebRTC] State with ${targetSocketId}: ${state}`);
        clearTimeout(meta.disconnectTimer);

        if (state === 'connected') {
          meta.restarts = 0;
        } else if (state === 'disconnected') {
          meta.disconnectTimer = setTimeout(() => restartPeer(targetSocketId), 4000);
        } else if (state === 'failed') {
          restartPeer(targetSocketId);
        } else if (state === 'closed') {
          cleanupPeer(targetSocketId);
        }
      };

      if (isInitiator) {
        sendOffer(targetSocketId);
      }

      return meta;
    },
    [cleanupPeer, restartPeer, sendOffer]
  );

  const resetPeers = useCallback(() => {
    Array.from(peers.current.keys()).forEach((id) => cleanupPeer(id));
    pendingCandidates.current.clear();
    setRemoteStreams(new Map());
  }, [cleanupPeer]);

  // Signaling listeners
  useEffect(() => {
    const handleUserJoined = ({ participant }) => {
      console.log(`[WebRTC] Existing user noticed new user: ${participant.name} (${participant.socketId})`);
      createPeerConnection(participant.socketId, false);
    };

    const flushCandidates = async (pc, socketId) => {
      const candidates = pendingCandidates.current.get(socketId) || [];
      pendingCandidates.current.delete(socketId);
      for (const candidate of candidates) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn('[WebRTC] Error adding queued ICE candidate:', err);
        }
      }
    };

    const handleSignalOffer = async ({ senderSocketId, offer }) => {
      console.log(`[WebRTC] Received offer from ${senderSocketId}`);
      const meta = peers.current.get(senderSocketId) || createPeerConnection(senderSocketId, false);
      const { pc } = meta;

      try {
        const collision = meta.makingOffer || pc.signalingState !== 'stable';
        if (collision) {
          if (meta.isInitiator) return;
          if (pc.signalingState === 'have-local-offer') {
            await pc.setLocalDescription({ type: 'rollback' });
          }
        }

        await pc.setRemoteDescription(offer);
        await flushCandidates(pc, senderSocketId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal-answer', { targetSocketId: senderSocketId, answer: pc.localDescription });
      } catch (err) {
        console.error('[WebRTC] Error handling offer:', err);
      }
    };

    const handleSignalAnswer = async ({ senderSocketId, answer }) => {
      console.log(`[WebRTC] Received answer from ${senderSocketId}`);
      const meta = peers.current.get(senderSocketId);
      if (!meta || meta.pc.signalingState !== 'have-local-offer') return;

      try {
        await meta.pc.setRemoteDescription(answer);
        await flushCandidates(meta.pc, senderSocketId);
      } catch (err) {
        console.error('[WebRTC] Error setting remote answer:', err);
      }
    };

    const handleIceCandidate = async ({ senderSocketId, candidate }) => {
      const meta = peers.current.get(senderSocketId);
      if (meta && meta.pc.remoteDescription && meta.pc.remoteDescription.type) {
        try {
          await meta.pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn('[WebRTC] Error adding ICE candidate:', err);
        }
      } else {
        if (!pendingCandidates.current.has(senderSocketId)) {
          pendingCandidates.current.set(senderSocketId, []);
        }
        pendingCandidates.current.get(senderSocketId).push(candidate);
      }
    };

    const handleRequestRenegotiation = ({ senderSocketId }) => {
      const meta = peers.current.get(senderSocketId);
      if (meta) sendOffer(senderSocketId, { iceRestart: true });
    };

    const handleUserLeft = ({ socketId }) => {
      cleanupPeer(socketId);
    };

    const handleScreenShareDenied = ({ sharerName }) => {
      alert(tRef.current.screenShareBusy(sharerName || '...'));
      stopScreenShareRef.current?.();
    };

    socket.on('user-joined', handleUserJoined);
    socket.on('signal-offer', handleSignalOffer);
    socket.on('signal-answer', handleSignalAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('request-renegotiation', handleRequestRenegotiation);
    socket.on('user-left', handleUserLeft);
    socket.on('screen-share-denied', handleScreenShareDenied);

    return () => {
      socket.off('user-joined', handleUserJoined);
      socket.off('signal-offer', handleSignalOffer);
      socket.off('signal-answer', handleSignalAnswer);
      socket.off('ice-candidate', handleIceCandidate);
      socket.off('request-renegotiation', handleRequestRenegotiation);
      socket.off('user-left', handleUserLeft);
      socket.off('screen-share-denied', handleScreenShareDenied);
    };
  }, [createPeerConnection, cleanupPeer, sendOffer]);

  const connectToExistingParticipants = useCallback(
    (participants) => {
      console.log(`[WebRTC] New user connecting to ${participants.length} existing participants`);
      participants.forEach((p) => {
        createPeerConnection(p.socketId, true);
      });
    },
    [createPeerConnection]
  );

  // -------------------------------------------------------------------------
  // Screen / video-file sharing
  // -------------------------------------------------------------------------
  const buildAudioMix = (connectExtraSource) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass();
    const dest = ctx.createMediaStreamDestination();

    const mic = getMicTrack();
    if (mic) ctx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
    connectExtraSource(ctx, dest);

    ctx.resume?.().catch(() => {});
    return { ctx, track: dest.stream.getAudioTracks()[0] };
  };

  const stopScreenShare = useCallback(async () => {
    const stream = screenStreamRef.current;
    if (!stream && !shareCleanupRef.current) return;

    screenStreamRef.current = null;
    screenVideoTrackRef.current = null;
    mixedAudioTrackRef.current = null;

    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (shareCleanupRef.current) {
      shareCleanupRef.current();
      shareCleanupRef.current = null;
    }

    setScreenStream(null);
    setSharedVideoElement(null);
    setIsScreenSharing(false);

    const camTrack = getCameraTrack();
    if (camTrack) camTrack.enabled = !isVideoOff;

    await replaceOutgoing('video', camTrack, true);
    await replaceOutgoing('audio', getMicTrack(), false);

    socket.emit('toggle-media', { mediaType: 'screen', enabled: false });
  }, [replaceOutgoing, isVideoOff]);

  stopScreenShareRef.current = stopScreenShare;

  const beginShare = useCallback(
    async ({ stream, mixed = null, mediaElement = null, cleanup = null, contentHint = 'detail' }) => {
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.enabled = true;

      screenStreamRef.current = stream;
      screenVideoTrackRef.current = videoTrack;
      mixedAudioTrackRef.current = mixed ? mixed.track : null;
      shareCleanupRef.current = () => {
        if (mixed?.ctx && mixed.ctx.state !== 'closed') mixed.ctx.close().catch(() => {});
        if (cleanup) cleanup();
      };

      try {
        videoTrack.contentHint = contentHint;
      } catch {
        // not supported
      }
      videoTrack.onended = () => stopScreenShareRef.current?.();

      setScreenStream(stream);
      setSharedVideoElement(mediaElement);
      setIsScreenSharing(true);

      await replaceOutgoing('video', videoTrack, true);
      if (mixed) await replaceOutgoing('audio', mixed.track, false);

      socket.emit('toggle-media', { mediaType: 'screen', enabled: true });
    },
    [replaceOutgoing]
  );

  const startScreenShare = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert(tRef.current.screenShareUnsupported);
      return false;
    }

    if (screenStreamRef.current) await stopScreenShareRef.current();

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') return false;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch (err2) {
        if (err2.name !== 'NotAllowedError' && err2.name !== 'AbortError') {
          console.warn('Screen share failed:', err2);
          alert(tRef.current.screenShareFailed);
        }
        return false;
      }
    }

    if (!stream.getVideoTracks()[0]) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    let mixed = null;
    const sharedAudio = stream.getAudioTracks()[0];
    if (sharedAudio) {
      try {
        mixed = buildAudioMix((ctx, dest) => {
          ctx.createMediaStreamSource(new MediaStream([sharedAudio])).connect(dest);
        });
      } catch (err) {
        console.warn('[WebRTC] Could not mix shared audio:', err);
      }
    }

    await beginShare({ stream, mixed, contentHint: 'detail' });
    return true;
  }, [beginShare]);

  const startVideoFileShare = useCallback(
    async (file) => {
      const proto = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : null;
      const capture = proto && (proto.captureStream || proto.mozCaptureStream);
      if (!capture) {
        alert(tRef.current.videoShareUnsupported);
        return false;
      }

      if (screenStreamRef.current) await stopScreenShareRef.current();

      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.src = objectUrl;
      video.playsInline = true;
      video.loop = false;
      video.preload = 'auto';
      video.style.cssText =
        'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.appendChild(video);

      const dispose = () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
        URL.revokeObjectURL(objectUrl);
      };

      let mixed = null;
      try {
        mixed = buildAudioMix((ctx, dest) => {
          ctx.createMediaElementSource(video).connect(dest);
        });

        await video.play();

        const captured = (video.captureStream || video.mozCaptureStream).call(video);
        const videoTrack = captured.getVideoTracks()[0];
        if (!videoTrack) throw new Error('No video track in file');

        await beginShare({
          stream: new MediaStream([videoTrack]),
          mixed,
          mediaElement: video,
          cleanup: dispose,
          contentHint: 'motion',
        });
        return true;
      } catch (err) {
        console.warn('Video file share failed:', err);
        if (mixed?.ctx && mixed.ctx.state !== 'closed') mixed.ctx.close().catch(() => {});
        dispose();
        alert(tRef.current.videoShareUnsupported);
        return false;
      }
    },
    [beginShare]
  );

  const reannounceSharing = useCallback(() => {
    if (screenStreamRef.current) {
      socket.emit('toggle-media', { mediaType: 'screen', enabled: true });
    }
  }, []);

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------
  const toggleRecording = useCallback(() => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      return;
    }

    const tracks = [getOutgoingVideoTrack(), getOutgoingAudioTrack()].filter(Boolean);
    if (tracks.length === 0) return;

    try {
      const options = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? { mimeType: 'video/webm;codecs=vp9' }
        : { mimeType: 'video/webm' };

      const recorder = new MediaRecorder(new MediaStream(tracks), options);
      recordedChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `conference-recording-${new Date().toISOString().slice(0, 19)}.webm`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }, 100);
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      console.error('Error starting media recorder:', err);
    }
  }, [isRecording]);

  // -------------------------------------------------------------------------
  // Teardown everything
  // -------------------------------------------------------------------------
  const leaveConference = useCallback(() => {
    initGenRef.current += 1;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    }
    if (shareCleanupRef.current) {
      shareCleanupRef.current();
      shareCleanupRef.current = null;
    }
    screenStreamRef.current = null;
    screenVideoTrackRef.current = null;
    mixedAudioTrackRef.current = null;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    stopVoiceActivity();
    Array.from(peers.current.keys()).forEach((id) => cleanupPeer(id));
    peers.current.clear();
    pendingCandidates.current.clear();
    setRemoteStreams(new Map());
    setScreenStream(null);
    setSharedVideoElement(null);
    setIsScreenSharing(false);
  }, [cleanupPeer, stopVoiceActivity]);

  return {
    localStream,
    remoteStreams,
    screenStream,
    sharedVideoElement,
    isScreenSharing,
    isAudioMuted,
    isVideoOff,
    isSpeaking,
    isRecording,
    initLocalStream,
    getMediaState,
    connectToExistingParticipants,
    resetPeers,
    reannounceSharing,
    toggleAudio,
    toggleVideo,
    startScreenShare,
    startVideoFileShare,
    stopScreenShare,
    toggleRecording,
    leaveConference,
  };
}
