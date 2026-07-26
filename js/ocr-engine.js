/* ============================================================
   ocr-engine.js — Tesseract.js OCR Integration
   PDF Studio Pro
   ============================================================ */

const OCREngine = {
    _worker:      null,
    _initialized: false,
    _busy:        false,

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
        const lang = document.getElementById('ocrLanguage').value;

        // Show progress
        document.getElementById('ocrProgressWrap').style.display = 'flex';
        document.getElementById('ocrResultWrap').style.display   = 'none';
        document.getElementById('ocrProgressBar').style.width    = '5%';
        document.getElementById('ocrProgressLabel').textContent  = 'Preparando...';

        // Disable buttons
        document.getElementById('btnOCRPage').disabled = true;
        document.getElementById('btnOCRAll').disabled  = true;

        UI.setStatus('Ejecutando OCR...', 'busy');

        try {
            const worker = await this._getWorker(lang);
            let fullText = '';

            if (mode === 'page') {
                // OCR current page only
                const imageData = await PDFViewer.getCurrentPageImage(2.5);
                const { data } = await worker.recognize(imageData);
                fullText = data.text;

            } else {
                // OCR all pages
                const totalPages = PDFViewer.getTotalPages();
                const label = document.getElementById('ocrProgressLabel');

                for (let i = 1; i <= totalPages; i++) {
                    label.textContent = `Analizando página ${i} de ${totalPages}...`;
                    document.getElementById('ocrProgressBar').style.width =
                        Math.round((i / totalPages) * 45 + 50) + '%';

                    const imageData = await PDFViewer.getPageImage(i, 2.5);
                    const { data } = await worker.recognize(imageData);
                    fullText += `\n\n--- Página ${i} ---\n\n` + data.text;
                }
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
            console.error('OCR Error:', err);
            document.getElementById('ocrProgressWrap').style.display = 'none';
            UI.setStatus('Error en OCR', 'error');
            UI.toast('Error en OCR: ' + err.message, 'error');
        } finally {
            this._busy = false;
            document.getElementById('btnOCRPage').disabled = false;
            document.getElementById('btnOCRAll').disabled  = false;
        }
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
                // Filter single/double char margin artifacts (like isolated 'A', 'a', 'e G')
                if (trimmed.length <= 2 && !/^\d+$/.test(trimmed) && !/^[A-Z]\.$/.test(trimmed)) {
                    return false;
                }
                return true;
            })
            .join('\n');
    }
};
