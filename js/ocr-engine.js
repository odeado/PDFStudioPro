/* ============================================================
   ocr-engine.js — Tesseract.js OCR Integration
   PDF Studio Pro
   ============================================================ */

const OCREngine = {
    _worker:      null,
    _initialized: false,
    _busy:        false,
    _cancelRequested: false,
    _structuredPages: {}, // { [pageNum]: { items: [{text,px,py,pw,ph}], width, height } }

    // ---- Initialize Tesseract Worker ----
    async _getWorker(lang) {
        // Terminate existing worker if language changed
        if (this._worker && this._currentLang !== lang) {
            await this._worker.terminate();
            this._worker = null;
            this._initialized = false;
        }

        if (!this._worker) {
            this._currentLang = lang;
            this._worker = await Tesseract.createWorker(lang, 1, {
                logger: (m) => this._onProgress(m)
            });
            try {
                await this._worker.setParameters({ preserve_interword_spaces: '1' });
            } catch (e) { /* not critical */ }
            this._initialized = true;
        }
        return this._worker;
    },

    _onProgress(msg) {
        const bar   = document.getElementById('ocrProgressBar');
        const label = document.getElementById('ocrProgressLabel');
        if (!bar || !label) return;

        if (msg.status === 'loading tesseract core') {
            label.textContent = 'Cargando motor Tesseract...';
            bar.style.width = '10%';
        } else if (msg.status === 'initializing tesseract') {
            label.textContent = 'Iniciando motor...';
            bar.style.width = '20%';
        } else if (msg.status === 'loading language traineddata') {
            label.textContent = 'Descargando datos de idioma...';
            bar.style.width = '35%';
        } else if (msg.status === 'initializing api') {
            label.textContent = 'Preparando API...';
            bar.style.width = '50%';
        } else if (msg.status === 'recognizing text') {
            const pct = 50 + Math.round(msg.progress * 45);
            bar.style.width = pct + '%';
            label.textContent = `Reconociendo texto... ${Math.round(msg.progress * 100)}%`;
        }
    },

    // ---- Light image enhancement before recognition (grayscale + contrast
    // stretch). Helps with low-contrast scans / phone photos. Deskewing is
    // intentionally out of scope — too risky to get right without a proper
    // image-processing library.
    _enhanceForOCR(canvas) {
        try {
            const ctx = canvas.getContext('2d');
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = imgData.data;
            const n = d.length;

            // First pass: grayscale + find the luminance range
            let min = 255, max = 0;
            const gray = new Uint8ClampedArray(n / 4);
            for (let i = 0, g = 0; i < n; i += 4, g++) {
                const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                gray[g] = lum;
                if (lum < min) min = lum;
                if (lum > max) max = lum;
            }

            const range = max - min;
            if (range < 10) return; // already flat/blank, stretching would just add noise

            const scale = 255 / range;
            for (let i = 0, g = 0; i < n; i += 4, g++) {
                const v = Math.min(255, Math.max(0, (gray[g] - min) * scale));
                d[i] = d[i + 1] = d[i + 2] = v;
            }

            ctx.putImageData(imgData, 0, 0);
        } catch (e) {
            console.warn('OCR image enhancement skipped:', e);
        }
    },

    // ---- Cancel an in-progress OCR run ----
    async cancelOCR() {
        if (!this._busy) return;
        this._cancelRequested = true;
        UI.setStatus('Cancelando OCR...', 'busy');
        try {
            if (this._worker) {
                await this._worker.terminate();
            }
        } catch (e) { /* ignore */ }
        this._worker = null;
        this._initialized = false;
    },

    // ---- Run OCR ----
    async runOCR(mode = 'page') {
        if (!App.isFileOpen) {
            UI.toast('Abre un PDF primero', 'warning');
            return;
        }
        if (this._busy) {
            UI.toast('OCR en progreso, espera un momento', 'info');
            return;
        }

        this._busy = true;
        this._cancelRequested = false;
        const lang = document.getElementById('ocrLanguage').value;

        // Show progress
        document.getElementById('ocrProgressWrap').style.display = 'flex';
        document.getElementById('ocrResultWrap').style.display   = 'none';
        document.getElementById('ocrProgressBar').style.width    = '5%';
        document.getElementById('ocrProgressLabel').textContent  = 'Preparando...';

        // Disable buttons, show cancel
        document.getElementById('btnOCRPage').disabled = true;
        document.getElementById('btnOCRAll').disabled  = true;
        const cancelBtn = document.getElementById('btnOCRCancel');
        if (cancelBtn) cancelBtn.style.display = 'inline-flex';

        UI.setStatus('Ejecutando OCR...', 'busy');

        try {
            const worker = await this._getWorker(lang);
            let fullText = '';

            if (mode === 'page') {
                // OCR current page only
                const pageNum = PDFViewer.getCurrentPage();
                const { data, width, height } = await this._recognizePage(worker, pageNum);
                fullText = data.text;
                this._storeStructure(pageNum, data, width, height);

            } else {
                // OCR all pages
                const totalPages = PDFViewer.getTotalPages();
                const label = document.getElementById('ocrProgressLabel');

                for (let i = 1; i <= totalPages; i++) {
                    if (this._cancelRequested) break;

                    label.textContent = `Analizando página ${i} de ${totalPages}...`;
                    document.getElementById('ocrProgressBar').style.width =
                        Math.round((i / totalPages) * 45 + 50) + '%';

                    const { data, width, height } = await this._recognizePage(worker, i);
                    fullText += `\n\n--- Página ${i} ---\n\n` + data.text;
                    this._storeStructure(i, data, width, height);
                }
            }

            if (this._cancelRequested) {
                UI.setStatus('OCR cancelado', 'info');
                UI.toast('OCR cancelado', 'info');
                return;
            }

            // Clean OCR text noise
            fullText = this._cleanText(fullText);

            // Show result
            document.getElementById('ocrProgressBar').style.width = '100%';
            document.getElementById('ocrProgressLabel').textContent = '¡Completado!';

            await App._sleep(500);

            document.getElementById('ocrProgressWrap').style.display = 'none';
            document.getElementById('ocrResultWrap').style.display   = 'flex';
            document.getElementById('ocrTextArea').value = fullText.trim();

            const lines = fullText.split('\n').filter(l => l.trim()).length;
            UI.setStatus(`OCR completado — ${lines} líneas extraídas`, 'ok');
            UI.toast('OCR completado exitosamente', 'success');

        } catch (err) {
            if (this._cancelRequested) {
                UI.setStatus('OCR cancelado', 'info');
                UI.toast('OCR cancelado', 'info');
            } else {
                console.error('OCR Error:', err);
                document.getElementById('ocrProgressWrap').style.display = 'none';
                UI.setStatus('Error en OCR', 'error');
                UI.toast('Error en OCR: ' + err.message, 'error');
            }
        } finally {
            this._busy = false;
            this._cancelRequested = false;
            document.getElementById('ocrProgressWrap').style.display = 'none';
            document.getElementById('btnOCRPage').disabled = false;
            document.getElementById('btnOCRAll').disabled  = false;
            if (cancelBtn) cancelBtn.style.display = 'none';
        }
    },

    // Render + enhance + recognize a single page, returning {data, width, height}
    async _recognizePage(worker, pageNum) {
        const imgInfo = await PDFViewer.getPageImage(pageNum, 2.5);
        this._enhanceForOCR(imgInfo.canvas);
        // Use a data URL (proven-supported input format) rather than passing
        // the canvas element directly.
        const dataUrl = imgInfo.canvas.toDataURL('image/png');
        const { data } = await worker.recognize(dataUrl, {}, { blocks: true, text: true });
        return { data, width: imgInfo.width, height: imgInfo.height };
    },

    // Flatten Tesseract's word-level output into the same {text,px,py,pw,ph}
    // shape that PDFViewer.getStructuredPageText() produces for native text,
    // so WordExport can run the exact same column/line-grouping/heading
    // detection regardless of whether the page came from real PDF text or
    // from OCR. Word-level (not line-level) granularity matters here: it
    // lets a line that straddles two columns still get split correctly.
    _storeStructure(pageNum, data, width, height) {
        const items = [];

        const pushWord = (word) => {
            const text = (word.text || '').trim();
            if (!text) return;
            const bbox = word.bbox || {};
            items.push({
                text,
                px: bbox.x0 || 0,
                py: bbox.y0 || 0,
                pw: (bbox.x1 || 0) - (bbox.x0 || 0),
                ph: (bbox.y1 || 0) - (bbox.y0 || 0)
            });
        };

        try {
            if (Array.isArray(data.words) && data.words.length) {
                // Flat word list, when Tesseract's output includes it directly.
                data.words.forEach(pushWord);
            } else if (Array.isArray(data.blocks)) {
                // Otherwise walk the block > paragraph > line > word hierarchy.
                for (const block of data.blocks) {
                    for (const para of (block.paragraphs || [])) {
                        for (const line of (para.lines || [])) {
                            const words = line.words || [];
                            if (words.length) {
                                words.forEach(pushWord);
                            } else if (line.text) {
                                // No word-level detail on this line — fall back
                                // to the whole line as a single item.
                                const text = line.text.trim();
                                if (text) {
                                    const bbox = line.bbox || {};
                                    items.push({
                                        text,
                                        px: bbox.x0 || 0,
                                        py: bbox.y0 || 0,
                                        pw: (bbox.x1 || 0) - (bbox.x0 || 0),
                                        ph: (bbox.y1 || 0) - (bbox.y0 || 0)
                                    });
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Could not parse OCR block structure for page', pageNum, e);
        }
        this._structuredPages[pageNum] = { items, width, height };
    },

    // Public accessor used by WordExport for scanned/OCR'd pages
    getPageStructure(pageNum) {
        return this._structuredPages[pageNum] || null;
    },

    // ---- Text Operations ----
    copyText() {
        const text = document.getElementById('ocrTextArea').value;
        if (!text.trim()) { UI.toast('No hay texto para copiar', 'warning'); return; }
        navigator.clipboard.writeText(text)
            .then(() => UI.toast('Texto copiado al portapapeles', 'success'))
            .catch(() => {
                // Fallback for file:// protocol
                const el = document.getElementById('ocrTextArea');
                el.select();
                document.execCommand('copy');
                UI.toast('Texto copiado', 'success');
            });
    },

    clearText() {
        document.getElementById('ocrTextArea').value = '';
        document.getElementById('ocrResultWrap').style.display = 'none';
    },

    getText() {
        return document.getElementById('ocrTextArea').value || '';
    },

    _cleanText(text) {
        if (!text) return '';
        return text
            .split('\n')
            .filter(line => {
                const trimmed = line.trim();
                // Only drop lone stray characters (typical scan-margin noise).
                // Legit short words ("Sí", "No", "Dr", "N°"...) are length >= 2
                // and should survive this filter.
                if (trimmed.length === 1 && !/^\d$/.test(trimmed)) {
                    return false;
                }
                return true;
            })
            .join('\n');
    }
};
