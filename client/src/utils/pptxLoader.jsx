import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';
// Bundle the PDF.js worker with the app (works offline / on a LAN, no dependency on a CDN)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
} catch (e) {
  console.warn('PDF worker setup:', e);
}

/**
 * The loaders below do NOT put image data into the slides as base64 strings.
 * They return slides that carry Blob objects (`mediaBlob` / `imageBlobs`), which the caller uploads
 * to the server over HTTP (see services/media.js). Only small urls are then sent through Socket.IO.
 */

const canvasToBlob = (canvas, type = 'image/jpeg', quality = 0.88) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas export failed'))), type, quality);
  });

/**
 * Loads a PDF file and converts each page into a crisp ~1920px wide slide image
 */
export async function loadPdfFile(file, onProgress) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const slides = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(1, 1920 / baseViewport.width));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      // JPEG has no transparency: paint a white page first
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await canvasToBlob(canvas);

      // free memory early, big PDFs have many pages
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      slides.push({
        id: `pdf-${Date.now()}-${pageNum}`,
        slideIndex: pageNum - 1,
        title: `${file.name} • Слайд ${pageNum}`,
        subtitle: `Саҳифа ${pageNum} / ${pdf.numPages}`,
        mediaType: 'image',
        mediaBlob: blob,
        bg: 'from-black to-gray-950',
      });

      if (onProgress) onProgress(pageNum, pdf.numPages);
    }

    pdf.destroy();
    return slides;
  } catch (err) {
    console.error('[PDF Loader] Failed to parse PDF:', err);
    throw new Error('PDF файлини очишда хатолик: ' + (err.message || ''));
  }
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

// Resolve a relationship Target such as "../media/image1.png" against the part that owns it
function resolvePartPath(basePartPath, target) {
  if (!target) return '';
  try {
    return new URL(target, `file:///${basePartPath}`).pathname.replace(/^\//, '');
  } catch {
    return target;
  }
}

function paragraphText(paragraphNode) {
  return Array.from(paragraphNode.getElementsByTagName('a:t'))
    .map((n) => n.textContent || '')
    .join('')
    .trim();
}

function isInsideTitleShape(node) {
  let cur = node.parentNode;
  while (cur) {
    if (cur.nodeName === 'p:sp') {
      const ph = cur.getElementsByTagName('p:ph')[0];
      const type = ph?.getAttribute('type');
      return type === 'title' || type === 'ctrTitle';
    }
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Parses a .pptx file: slide text (title + bullet lines) and the pictures used on every slide.
 * Slides are returned in the REAL presentation order (not by file name).
 * Note: PowerPoint animations, shapes and fonts cannot be rendered here - for pixel-perfect output
 * use "Share screen" with the PowerPoint slideshow (F5) or export the deck to PDF.
 */
export async function loadPptxFile(file, onProgress) {
  if (/\.ppt$/i.test(file.name)) {
    throw new Error('Эски .ppt формати қўллаб-қувватланмайди. Файлни .pptx ёки PDF сифатида сақланг.');
  }

  try {
    const zip = new JSZip();
    const contents = await zip.loadAsync(file);
    const parser = new DOMParser();

    // 1. Slide order from ppt/presentation.xml
    let slideFiles = [];
    try {
      const presXml = await contents.file('ppt/presentation.xml').async('text');
      const relsXml = await contents.file('ppt/_rels/presentation.xml.rels').async('text');
      const presDoc = parser.parseFromString(presXml, 'application/xml');
      const relsDoc = parser.parseFromString(relsXml, 'application/xml');

      const targetById = {};
      Array.from(relsDoc.getElementsByTagName('Relationship')).forEach((rel) => {
        targetById[rel.getAttribute('Id')] = rel.getAttribute('Target');
      });

      slideFiles = Array.from(presDoc.getElementsByTagName('p:sldId'))
        .map((node) => node.getAttribute('r:id'))
        .map((rid) => resolvePartPath('ppt/presentation.xml', targetById[rid]))
        .filter((path) => path && contents.file(path));
    } catch {
      slideFiles = [];
    }

    // Fallback: numeric order of the file names
    if (slideFiles.length === 0) {
      slideFiles = Object.keys(contents.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
    }

    // 2. Pictures: every media file is read ONCE and shared by all slides that use it
    const mediaCache = new Map(); // path -> Blob | null
    const getMediaBlob = async (path) => {
      if (mediaCache.has(path)) return mediaCache.get(path);
      const ext = path.split('.').pop().toLowerCase();
      const entry = MIME_BY_EXT[ext] ? contents.file(path) : null;
      const blob = entry ? new Blob([await entry.async('arraybuffer')], { type: MIME_BY_EXT[ext] }) : null;
      mediaCache.set(path, blob);
      return blob;
    };

    const slides = [];

    for (let i = 0; i < slideFiles.length; i++) {
      const slidePath = slideFiles[i];
      const xmlText = await contents.file(slidePath).async('text');

      // Pictures that belong to THIS slide (from its relationships)
      const imageBlobs = [];
      const relsPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      if (contents.file(relsPath)) {
        try {
          const relsDoc = parser.parseFromString(await contents.file(relsPath).async('text'), 'application/xml');
          for (const rel of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
            if (!/\/image$/.test(rel.getAttribute('Type') || '')) continue;
            const blob = await getMediaBlob(resolvePartPath(slidePath, rel.getAttribute('Target')));
            if (blob && !imageBlobs.includes(blob)) imageBlobs.push(blob);
          }
        } catch {
          // ignore rels error
        }
      }

      // Text: one line per paragraph, the title placeholder becomes the slide title
      const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
      let title = '';
      const bodyLines = [];
      Array.from(xmlDoc.getElementsByTagName('a:p')).forEach((p) => {
        const text = paragraphText(p);
        if (!text) return;
        if (!title && isInsideTitleShape(p)) title = text;
        else bodyLines.push(text);
      });

      const isFullImageSlide = imageBlobs.length > 0 && bodyLines.length === 0 && !title;

      slides.push({
        id: `pptx-slide-${Date.now()}-${i + 1}`,
        slideIndex: i,
        title: title || `${file.name} — Слайд ${i + 1}`,
        subtitle: `${file.name} • Слайд ${i + 1} / ${slideFiles.length}`,
        mediaType: isFullImageSlide ? 'image' : 'pptx-slide',
        mediaBlob: isFullImageSlide ? imageBlobs[0] : null,
        imageBlobs: isFullImageSlide ? [] : imageBlobs,
        lines: bodyLines,
        bg: 'from-gray-950 to-black',
      });

      if (onProgress) onProgress(i + 1, slideFiles.length);
    }

    if (slides.length === 0) {
      throw new Error('Слайдлар топилмади');
    }

    return slides;
  } catch (err) {
    console.error('[PPTX Loader] Error:', err);
    throw new Error('PowerPoint файлини очишда хатолик: ' + (err.message || ''));
  }
}
