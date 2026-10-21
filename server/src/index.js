import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../../client/dist');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(clientDistPath));

// In-memory room store: roomId -> { participants: Map, attendance: Map, presentation: Object, chatHistory: Array }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      endedAt: null,
      participants: new Map(), // socketId -> { id, name, isHost, audioEnabled, videoEnabled, isHandRaised, isScreenSharing }
      attendance: new Map(),   // key -> attendee attendance record
      presentation: null,     // { presenterId, title, currentSlide, totalSlides, slides: [] }
      drawings: {},           // slideIndex -> Array of paths
      chatHistory: [],        // Array of { id, sender, text, timestamp, isSystem }
      mediaFiles: new Map(),  // uploaded slide media: fileName -> size in bytes
      mediaBytes: 0,
      finalReport: null
    });
  }
  return rooms.get(roomId);
}


// ---------------------------------------------------------------------------
// Presentation media storage
// Slides (PDF pages, images, PPTX pictures) are uploaded over HTTP and stored on
// disk. Only small URLs travel through Socket.IO, so a big file can no longer
// overflow the socket buffer and silently disconnect the presenter.
// ---------------------------------------------------------------------------
const MEDIA_ROOT = path.join(os.tmpdir(), 'telemeet-media');
const MAX_MEDIA_FILE_BYTES = 60 * 1024 * 1024;   // per uploaded file
const MAX_ROOM_MEDIA_BYTES = 500 * 1024 * 1024;  // per room
const MAX_SLIDES = 500;
const MAX_DECK_JSON_BYTES = 4 * 1024 * 1024;     // slide metadata only (text + urls)
const MAX_STROKES_PER_SLIDE = 3000;
const MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MEDIA_FILE_RE = /^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/;

function roomMediaDir(roomId) {
  // Hash the (user supplied) room id so it can never be used for path traversal
  return path.join(MEDIA_ROOT, crypto.createHash('sha1').update(String(roomId)).digest('hex'));
}

async function clearRoomMedia(room) {
  if (!room) return;
  room.mediaFiles.clear();
  room.mediaBytes = 0;
  try {
    await fs.promises.rm(roomMediaDir(room.id), { recursive: true, force: true });
  } catch (err) {
    console.warn('[Media] cleanup failed:', err.message);
  }
}

// Delete uploaded files that the current presentation no longer references
async function pruneRoomMedia(room) {
  if (!room) return;
  const used = room.presentation ? JSON.stringify(room.presentation) : '';
  for (const [fileName, size] of Array.from(room.mediaFiles.entries())) {
    if (used.includes(fileName)) continue;
    room.mediaFiles.delete(fileName);
    room.mediaBytes = Math.max(0, room.mediaBytes - size);
    fs.promises.rm(path.join(roomMediaDir(room.id), fileName), { force: true }).catch(() => {});
  }
}

function sanitizeDeck(input) {
  const src = input && typeof input === 'object' ? input : {};
  const slides = Array.isArray(src.slides) ? src.slides.slice(0, MAX_SLIDES) : [];
  const currentSlide = Math.min(Math.max(parseInt(src.currentSlide, 10) || 0, 0), Math.max(slides.length - 1, 0));
  const deck = {
    title: String(src.title || '').slice(0, 300),
    totalSlides: slides.length,
    currentSlide,
    slides,
  };
  if (JSON.stringify(deck).length > MAX_DECK_JSON_BYTES) return null;
  return deck;
}

// Start from a clean media folder on every server start
try {
  fs.rmSync(MEDIA_ROOT, { recursive: true, force: true });
  fs.mkdirSync(MEDIA_ROOT, { recursive: true });
} catch (err) {
  console.warn('[Media] could not prepare media folder:', err.message);
}

function generateRoomReport(room) {
  const now = room.endedAt || Date.now();
  const totalDurationMs = Math.max(0, now - room.createdAt);

  const attendees = Array.from(room.attendance.values()).map(att => {
    let currentTotalMeetingMs = att.totalMeetingTimeMs || 0;
    if (att.isOnline && att.meetingJoinSince) {
      currentTotalMeetingMs += Math.max(0, now - att.meetingJoinSince);
    }

    let currentCameraOnMs = att.cameraOnTimeMs || 0;
    if (att.isOnline && att.cameraActiveSince) {
      currentCameraOnMs += Math.max(0, now - att.cameraActiveSince);
    }

    let currentMicOnMs = att.micOnTimeMs || 0;
    if (att.isOnline && att.micActiveSince) {
      currentMicOnMs += Math.max(0, now - att.micActiveSince);
    }

    const cameraPercentage = currentTotalMeetingMs > 0
      ? Math.min(100, Math.round((currentCameraOnMs / currentTotalMeetingMs) * 100))
      : 0;

    return {
      id: att.id,
      name: att.name,
      isHost: !!att.isHost,
      isOnline: !!att.isOnline,
      firstJoinedAt: att.firstJoinedAt,
      lastLeftAt: att.isOnline ? null : att.lastLeftAt,
      totalMeetingTimeMs: currentTotalMeetingMs,
      totalMeetingMinutes: Number((currentTotalMeetingMs / 60000).toFixed(1)),
      cameraOnTimeMs: currentCameraOnMs,
      cameraOnMinutes: Number((currentCameraOnMs / 60000).toFixed(1)),
      cameraPercentage,
      micOnMinutes: Number((currentMicOnMs / 60000).toFixed(1)),
    };
  });

  // Calculate average camera engagement
  const totalCamMs = attendees.reduce((sum, a) => sum + a.cameraOnTimeMs, 0);
  const totalAttendMs = attendees.reduce((sum, a) => sum + a.totalMeetingTimeMs, 0);
  const avgCameraPercentage = totalAttendMs > 0 ? Math.min(100, Math.round((totalCamMs / totalAttendMs) * 100)) : 0;

  return {
    roomId: room.id,
    createdAt: room.createdAt,
    endedAt: room.endedAt || now,
    totalDurationMs,
    totalDurationMinutes: Number((totalDurationMs / 60000).toFixed(1)),
    totalParticipantsCount: room.attendance.size,
    avgCameraPercentage,
    attendees
  };
}

// REST API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size, timestamp: new Date() });
});

app.post('/api/rooms/create', (req, res) => {
  const roomId = uuidv4().substring(0, 10);
  getOrCreateRoom(roomId);
  res.json({ roomId, success: true });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    roomId: room.id,
    participantCount: room.participants.size,
    hasPresentation: !!room.presentation,
    createdAt: room.createdAt
  });
});

app.get('/api/rooms/:roomId/report', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const report = room.finalReport || generateRoomReport(room);
  res.json({ success: true, report });
});

app.post(
  '/api/rooms/:roomId/media',
  express.raw({ type: () => true, limit: MAX_MEDIA_FILE_BYTES }),
  async (req, res) => {
    try {
      const { roomId } = req.params;
      const room = rooms.get(roomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      // Only people who are inside the room may upload
      const socketId = String(req.headers['x-socket-id'] || '');
      if (!room.participants.has(socketId)) {
        return res.status(403).json({ error: 'Not a participant of this room' });
      }

      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = MEDIA_TYPES[contentType];
      if (!ext) return res.status(415).json({ error: 'Unsupported media type' });

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: 'Empty file' });
      }
      if (room.mediaBytes + body.length > MAX_ROOM_MEDIA_BYTES) {
        return res.status(413).json({ error: 'Room media quota exceeded' });
      }

      const fileName = `${uuidv4()}.${ext}`;
      const dir = roomMediaDir(roomId);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, fileName), body);
      room.mediaFiles.set(fileName, body.length);
      room.mediaBytes += body.length;

      res.json({ success: true, url: `/api/media/${encodeURIComponent(roomId)}/${fileName}` });
    } catch (err) {
      console.error('[Media] upload failed:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

app.get('/api/media/:roomId/:fileName', (req, res) => {
  const { roomId, fileName } = req.params;
  if (!MEDIA_FILE_RE.test(fileName)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(roomMediaDir(roomId), fileName), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Socket.IO Real-time Signaling & State Management
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 2e7, // 20MB: sockets only carry small JSON now, files go through /api/rooms/:id/media
  pingTimeout: 60000,
  pingInterval: 25000
});

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUserId = null;

  // 1. Join Room
  socket.on('join-room', ({ roomId, user: joinUser } = {}) => {
    if (!roomId || typeof roomId !== 'string' || currentRoomId) return;
    const user = joinUser && typeof joinUser === 'object' ? joinUser : {};
    currentRoomId = roomId;
    currentUserId = socket.id;

    socket.join(roomId);

    const room = getOrCreateRoom(roomId);
    const isFirstParticipant = room.participants.size === 0;

    const participant = {
      socketId: socket.id,
      id: user.id || socket.id,
      name: user.name || 'Иштирокчи',
      avatarColor: user.avatarColor || '#3B82F6',
      isHost: isFirstParticipant,
      audioEnabled: user.audioEnabled ?? true,
      videoEnabled: user.videoEnabled ?? true,
      isHandRaised: false,
      isScreenSharing: false,
      joinedAt: Date.now()
    };

    room.participants.set(socket.id, participant);

    // Track attendee in room.attendance
    const attendeeKey = (user.name || 'Иштирокчи').trim().toLowerCase();
    socket.attendeeKey = attendeeKey;
    const now = Date.now();

    if (!room.attendance.has(attendeeKey)) {
      room.attendance.set(attendeeKey, {
        id: socket.id,
        name: participant.name,
        isHost: participant.isHost,
        firstJoinedAt: now,
        lastJoinedAt: now,
        lastLeftAt: null,
        isOnline: true,
        totalMeetingTimeMs: 0,
        cameraOnTimeMs: 0,
        micOnTimeMs: 0,
        meetingJoinSince: now,
        cameraActiveSince: participant.videoEnabled ? now : null,
        micActiveSince: participant.audioEnabled ? now : null
      });
    } else {
      const att = room.attendance.get(attendeeKey);
      att.isOnline = true;
      att.id = socket.id;
      att.lastJoinedAt = now;
      att.meetingJoinSince = now;
      if (participant.videoEnabled) {
        att.cameraActiveSince = now;
      }
      if (participant.audioEnabled) {
        att.micActiveSince = now;
      }
      if (participant.isHost) {
        att.isHost = true;
      }
    }

    // List of existing participants to return to the new joiner
    const existingParticipants = Array.from(room.participants.values()).filter(p => p.socketId !== socket.id);

    // Send back room state to new user
    socket.emit('room-joined', {
      self: participant,
      participants: existingParticipants,
      presentation: room.presentation,
      drawings: room.drawings,
      chatHistory: room.chatHistory.slice(-50),
      sessionReport: generateRoomReport(room)
    });

    // Notify others in room
    socket.to(roomId).emit('user-joined', {
      participant
    });

    // Add system chat message
    const joinMessage = {
      id: uuidv4(),
      sender: 'Система',
      text: `${participant.name} конференцияга қўшилди`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSystem: true
    };
    room.chatHistory.push(joinMessage);
    io.to(roomId).emit('chat-message', joinMessage);

    console.log(`[Join] User ${participant.name} (${socket.id}) joined room ${roomId}. Total: ${room.participants.size}`);
  });

  // 2. WebRTC Peer Signaling (Offer, Answer, ICE Candidate)
  socket.on('signal-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('signal-offer', {
      senderSocketId: socket.id,
      offer
    });
  });

  socket.on('signal-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('signal-answer', {
      senderSocketId: socket.id,
      answer
    });
  });

  // A peer asks the connection initiator to redo the offer (ICE restart after a network drop)
  socket.on('request-renegotiation', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('request-renegotiation', { senderSocketId: socket.id });
  });

  socket.on('ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('ice-candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // 3. Media Controls (Audio, Video, Screen Share)
  socket.on('toggle-media', ({ mediaType, enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    if (participant) {
      // Only one person can share the screen at a time
      if (mediaType === 'screen' && enabled) {
        const otherSharer = Array.from(room.participants.values()).find(
          (p) => p.socketId !== socket.id && p.isScreenSharing
        );
        if (otherSharer) {
          socket.emit('screen-share-denied', { sharerName: otherSharer.name });
          return;
        }
      }

      if (mediaType === 'audio') participant.audioEnabled = enabled;
      if (mediaType === 'video') participant.videoEnabled = enabled;
      if (mediaType === 'screen') {
        participant.isScreenSharing = enabled;
        if (enabled && room.presentation && room.presentation.presenterSocketId === socket.id) {
          room.presentation = null;
          room.drawings = {};
          clearRoomMedia(room);
          io.to(currentRoomId).emit('presentation-stopped');
        }
      }

      // Track camera and mic duration
      const attendeeKey = socket.attendeeKey;
      if (attendeeKey && room.attendance.has(attendeeKey)) {
        const att = room.attendance.get(attendeeKey);
        const now = Date.now();
        if (mediaType === 'video') {
          if (enabled) {
            if (!att.cameraActiveSince) att.cameraActiveSince = now;
          } else {
            if (att.cameraActiveSince) {
              att.cameraOnTimeMs = (att.cameraOnTimeMs || 0) + (now - att.cameraActiveSince);
              att.cameraActiveSince = null;
            }
          }
        }
        if (mediaType === 'audio') {
          if (enabled) {
            if (!att.micActiveSince) att.micActiveSince = now;
          } else {
            if (att.micActiveSince) {
              att.micOnTimeMs = (att.micOnTimeMs || 0) + (now - att.micActiveSince);
              att.micActiveSince = null;
            }
          }
        }
      }

      io.to(currentRoomId).emit('user-media-toggled', {
        socketId: socket.id,
        mediaType,
        enabled
      });
    }
  });

  // 4. Raise Hand
  socket.on('toggle-raise-hand', ({ raised }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    if (participant) {
      participant.isHandRaised = raised;
      io.to(currentRoomId).emit('user-hand-toggled', {
        socketId: socket.id,
        isHandRaised: raised,
        userName: participant.name
      });
    }
  });

  // 5. Emoji Reactions
  socket.on('send-reaction', ({ emoji }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const participant = room?.participants.get(socket.id);
    const senderName = participant?.name || 'Иштирокчи';

    io.to(currentRoomId).emit('reaction-received', {
      id: uuidv4(),
      socketId: socket.id,
      userName: senderName,
      emoji
    });
  });

  // 6. Text Chat
  socket.on('send-chat', ({ text }) => {
    if (!currentRoomId || !text?.trim()) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    const message = {
      id: uuidv4(),
      senderSocketId: socket.id,
      sender: participant?.name || 'Иштирокчи',
      text: text.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSystem: false
    };

    room.chatHistory.push(message);
    if (room.chatHistory.length > 200) room.chatHistory.shift();

    io.to(currentRoomId).emit('chat-message', message);
  });

  // 7. Interactive Presentation & Slides
  const isPresenterSocket = (room) => room?.presentation?.presenterSocketId === socket.id;

  socket.on('start-presentation', ({ presentation } = {}, ack) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    if (!participant) return;

    // Somebody else is already presenting: only the host may take over
    if (room.presentation && !isPresenterSocket(room) && !participant.isHost) {
      socket.emit('presentation-denied', { presenterName: room.presentation.presenterName });
      if (typeof ack === 'function') ack({ ok: false, reason: 'busy' });
      return;
    }

    const deck = sanitizeDeck(presentation);
    if (!deck) {
      socket.emit('presentation-error', { reason: 'too-large' });
      if (typeof ack === 'function') ack({ ok: false, reason: 'too-large' });
      return;
    }

    room.presentation = {
      ...deck,
      presenterSocketId: socket.id,
      presenterName: participant.name || 'Бошловчи',
    };
    room.drawings = {};
    pruneRoomMedia(room);

    io.to(currentRoomId).emit('presentation-started', room.presentation);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('presentation-update-deck', ({ presentation } = {}, ack) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Only the current presenter may replace the slides
    if (!isPresenterSocket(room)) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'not-presenter' });
      return;
    }

    const deck = sanitizeDeck(presentation);
    if (!deck) {
      socket.emit('presentation-error', { reason: 'too-large' });
      if (typeof ack === 'function') ack({ ok: false, reason: 'too-large' });
      return;
    }

    room.presentation = {
      ...room.presentation,
      ...deck,
      presenterSocketId: socket.id,
      currentSlide: 0,
    };
    room.drawings = {};
    pruneRoomMedia(room);

    io.to(currentRoomId).emit('presentation-deck-updated', room.presentation);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('stop-presentation', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Presenter or host can stop it - other participants cannot
    const participant = room.participants.get(socket.id);
    if (room.presentation && !isPresenterSocket(room) && !participant?.isHost) return;

    room.presentation = null;
    room.drawings = {};
    clearRoomMedia(room);
    io.to(currentRoomId).emit('presentation-stopped');
  });

  socket.on('presentation-change-slide', ({ slideIndex }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.presentation) return;

    // Only presenter can change slides
    const idx = parseInt(slideIndex, 10);
    const total = room.presentation.slides?.length || 0;
    if (isPresenterSocket(room) && Number.isInteger(idx) && idx >= 0 && idx < Math.max(total, 1)) {
      room.presentation.currentSlide = idx;
      io.to(currentRoomId).emit('presentation-slide-updated', { slideIndex: idx });
    }
  });

  socket.on('presentation-laser-move', ({ x, y, active }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!isPresenterSocket(room)) return;
    // Broadcast laser pointer coordinates to all other participants
    socket.to(currentRoomId).emit('presentation-laser-updated', {
      presenterSocketId: socket.id,
      x,
      y,
      active
    });
  });

  socket.on('presentation-draw-stroke', ({ slideIndex, stroke }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !isPresenterSocket(room) || !stroke || !Array.isArray(stroke.points)) return;

    if (!room.drawings[slideIndex]) {
      room.drawings[slideIndex] = [];
    }
    if (room.drawings[slideIndex].length >= MAX_STROKES_PER_SLIDE) return;
    room.drawings[slideIndex].push(stroke);

    socket.to(currentRoomId).emit('presentation-stroke-received', {
      slideIndex,
      stroke
    });
  });

  socket.on('presentation-clear-drawings', ({ slideIndex } = {}) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !isPresenterSocket(room)) return;

    if (slideIndex !== undefined) {
      room.drawings[slideIndex] = [];
    } else {
      room.drawings = {};
    }

    io.to(currentRoomId).emit('presentation-drawings-cleared', { slideIndex });
  });

  // 8. Host Moderation Controls
  socket.on('host-mute-participant', ({ targetSocketId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const host = room?.participants.get(socket.id);
    if (host?.isHost) {
      io.to(targetSocketId).emit('force-mute-audio');
    }
  });

  socket.on('host-mute-all', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const host = room?.participants.get(socket.id);
    if (host?.isHost) {
      socket.to(currentRoomId).emit('force-mute-audio');
    }
  });

  socket.on('host-kick-participant', ({ targetSocketId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const host = room?.participants.get(socket.id);
    if (host?.isHost) {
      io.to(targetSocketId).emit('kicked-from-room');
    }
  });

  // 9. Meeting Report & End Meeting For All
  socket.on('get-meeting-report', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const report = room.finalReport || generateRoomReport(room);
    socket.emit('meeting-report-data', report);
  });

  socket.on('end-meeting-for-all', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    if (!participant?.isHost) return;

    const now = Date.now();
    room.endedAt = now;

    // Finalize all active attendees
    for (const att of room.attendance.values()) {
      if (att.isOnline) {
        if (att.meetingJoinSince) {
          att.totalMeetingTimeMs = (att.totalMeetingTimeMs || 0) + (now - att.meetingJoinSince);
          att.meetingJoinSince = null;
        }
        if (att.cameraActiveSince) {
          att.cameraOnTimeMs = (att.cameraOnTimeMs || 0) + (now - att.cameraActiveSince);
          att.cameraActiveSince = null;
        }
        if (att.micActiveSince) {
          att.micOnTimeMs = (att.micOnTimeMs || 0) + (now - att.micActiveSince);
          att.micActiveSince = null;
        }
        att.isOnline = false;
        att.lastLeftAt = now;
      }
    }

    const report = generateRoomReport(room);
    room.finalReport = report;

    // Broadcast report to everyone in the room
    io.to(currentRoomId).emit('meeting-ended-with-report', {
      report,
      endedByHost: true,
      hostName: participant.name
    });

    console.log(`[Meeting Ended] Room ${currentRoomId} ended by host ${participant.name}. Duration: ${report.totalDurationMinutes} mins, Attendees: ${report.attendees.length}`);
  });

  // 10. Disconnect
  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Update attendee attendance stats upon disconnect
    const attendeeKey = socket.attendeeKey;
    if (attendeeKey && room.attendance.has(attendeeKey)) {
      const att = room.attendance.get(attendeeKey);
      const now = Date.now();
      att.isOnline = false;
      att.lastLeftAt = now;
      if (att.meetingJoinSince) {
        att.totalMeetingTimeMs = (att.totalMeetingTimeMs || 0) + (now - att.meetingJoinSince);
        att.meetingJoinSince = null;
      }
      if (att.cameraActiveSince) {
        att.cameraOnTimeMs = (att.cameraOnTimeMs || 0) + (now - att.cameraActiveSince);
        att.cameraActiveSince = null;
      }
      if (att.micActiveSince) {
        att.micOnTimeMs = (att.micOnTimeMs || 0) + (now - att.micActiveSince);
        att.micActiveSince = null;
      }
    }

    const participant = room.participants.get(socket.id);
    if (participant) {
      room.participants.delete(socket.id);

      // If presenter left, stop presentation
      if (room.presentation?.presenterSocketId === socket.id) {
        room.presentation = null;
        room.drawings = {};
        clearRoomMedia(room);
        io.to(currentRoomId).emit('presentation-stopped');
      }

      // If host left and there are other participants, assign host to next participant
      if (participant.isHost && room.participants.size > 0) {
        const nextHost = room.participants.values().next().value;
        nextHost.isHost = true;
        io.to(currentRoomId).emit('host-changed', { newHostSocketId: nextHost.socketId });
      }

      io.to(currentRoomId).emit('user-left', {
        socketId: socket.id,
        name: participant.name
      });

      const leaveMessage = {
        id: uuidv4(),
        sender: 'Система',
        text: `${participant.name} тарк этди`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSystem: true
      };
      room.chatHistory.push(leaveMessage);
      io.to(currentRoomId).emit('chat-message', leaveMessage);

      console.log(`[Leave] User ${participant.name} (${socket.id}) left room ${currentRoomId}. Remaining: ${room.participants.size}`);

      // Clean up empty rooms after 1 hour
      if (room.participants.size === 0) {
        setTimeout(() => {
          const emptyRoom = rooms.get(currentRoomId);
          if (emptyRoom?.participants.size === 0) {
            clearRoomMedia(emptyRoom);
            rooms.delete(currentRoomId);
            console.log(`[Cleanup] Room ${currentRoomId} deleted`);
          }
        }, 3600000);
      }
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 Video Conference Server running on port ${PORT}`);
  console.log(`📡 Ready for WebRTC signaling and Presentations`);
  console.log(`===============================================`);
});
