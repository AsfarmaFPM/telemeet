import { SERVER_URL, socket } from './socket';

/**
 * Uploads one image (slide page, picture) to the server and returns its relative url.
 * Files go over plain HTTP so that large slide decks never travel through the socket.
 */
export async function uploadMedia(roomId, blob) {
  const contentType = blob.type || 'application/octet-stream';
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/media`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'x-socket-id': socket.id || '',
      },
      body: blob,
    });
  } catch (err) {
    throw new Error('Серверга уланиб бўлмади / Нет связи с сервером');
  }

  if (!res.ok) {
    let reason = '';
    try {
      reason = (await res.json()).error || '';
    } catch {
      // ignore
    }
    if (res.status === 413) throw new Error('Файл жуда катта / Файл слишком большой');
    if (res.status === 415) throw new Error('Файл формати қўллаб-қувватланмайди / Формат не поддерживается');
    throw new Error(reason || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.url;
}

/**
 * Takes slides produced by the loaders (which carry Blob objects) and uploads every
 * unique blob once. Returns clean, JSON-serialisable slides that only contain urls.
 */
export async function uploadSlideBlobs(roomId, slides, onProgress, concurrency = 3) {
  const unique = new Map(); // Blob -> url
  for (const slide of slides) {
    if (slide.mediaBlob) unique.set(slide.mediaBlob, null);
    (slide.imageBlobs || []).forEach((b) => unique.set(b, null));
  }

  const blobs = Array.from(unique.keys());
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < blobs.length) {
      const blob = blobs[cursor++];
      unique.set(blob, await uploadMedia(roomId, blob));
      done += 1;
      if (onProgress) onProgress(done, blobs.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, blobs.length) }, worker));

  return slides.map((slide) => {
    // eslint-disable-next-line no-unused-vars
    const { mediaBlob, imageBlobs, ...rest } = slide;
    return {
      ...rest,
      mediaSrc: mediaBlob ? unique.get(mediaBlob) : rest.mediaSrc || null,
      images: (imageBlobs || []).map((b) => unique.get(b)),
    };
  });
}
