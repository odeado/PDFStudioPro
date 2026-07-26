/* ============================================================
   signature.js — Digital Signature with signature_pad
   PDF Studio Pro
   ============================================================ */

const Signature = {
    _pad:      null,
    _color:    '#0d1117',
    _position: 'bl',   // bottom-left by default

    // ---- Initialize ----
    init() {
        const canvas = document.getElementById('signatureCanvas');
        if (!canvas || typeof SignaturePad === 'undefined') return;

        this._pad = new SignaturePad(canvas, {
            penColor:      this._color,
            backgroundColor: 'rgba(255,255,255,0)',
            minWidth:      1,
            maxWidth:      3,
        });

        this.resize();

        // Hide hint when drawing starts
        this._pad.addEventListener('beginStroke', () => {
            const hint = canvas.parentElement.querySelector('.sig-hint');
            if (hint) hint.style.opacity = '0';
        });
    },

    resize() {
        const canvas = document.getElementById('signatureCanvas');
        if (!canvas || !this._pad) return;

        const ratio  = Math.max(window.devicePixelRatio || 1, 1);
        const wrap   = canvas.parentElement;
        const w      = wrap.offsetWidth;
        const h      = 140;

        canvas.width  = w * ratio;
        canvas.height = h * ratio;
        canvas.style.width  = w + 'px';
        canvas.style.height = h + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);

        // Restore data after resize
        this._pad.clear();
    },

    // ---- Color ----
    setColor(btn) {
        document.querySelectorAll('.ink-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._color = btn.dataset.color;
        if (this._pad) this._pad.penColor = this._color;
    },

    // ---- Position ----
    setPosition(btn) {
        document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._position = btn.dataset.pos;
    },

    // ---- Clear ----
    clear() {
        if (!this._pad) return;
        this._pad.clear();
        const hint = document.querySelector('.sig-hint');
        if (hint) hint.style.opacity = '1';
    },

    // ---- Stamp Signature on PDF ----
    async stamp() {
        if (!App.isFileOpen) {
            UI.toast('Abre un PDF primero', 'warning');
            return;
        }
        if (!this._pad || this._pad.isEmpty()) {
            UI.toast('Dibuja tu firma antes de estampar', 'warning');
            return;
        }

        UI.setStatus('Estampando firma...', 'busy');

        try {
            // Get signature as PNG image
            const signDataUrl = this._pad.toDataURL('image/png');
            const signBytes   = this._dataURLToBytes(signDataUrl);

            // Load PDF with pdf-lib
            const doc = await PDFLib.PDFDocument.load(App.pdfBytes, { ignoreEncryption: true });
            const pages = doc.getPages();
            const pageIdx = PDFViewer.getCurrentPage() - 1;
            const page  = pages[pageIdx];

            const { width: pW, height: pH } = page.getSize();

            // Embed PNG
            const pngImage = await doc.embedPng(signBytes);
            const pngDims  = pngImage.scale(1);

            // Desired display size
            const sigDisplaySize = parseInt(document.getElementById('signatureSize').value) || 200;
            const aspectRatio = pngDims.width / pngDims.height;
            const sigW = sigDisplaySize;
            const sigH = sigDisplaySize / aspectRatio;

            // Margin
            const margin = 20;

            // Calculate position
            const pos = this._calculatePosition(pW, pH, sigW, sigH, margin);

            page.drawImage(pngImage, {
                x: pos.x,
                y: pos.y,
                width:  sigW,
                height: sigH,
            });

            // Save and reload
            const bytes = await doc.save();
            await PDFViewer.reload(bytes);
            App.pdfBytes = new Uint8Array(bytes);
            PdfTools.currentPdfLib = doc;

            UI.setStatus('Firma estampada correctamente', 'ok');
            UI.toast('¡Firma estampada en la página ' + (pageIdx + 1) + '!', 'success');

        } catch (err) {
            console.error('Signature stamp error:', err);
            UI.setStatus('Error al estampar firma', 'error');
            UI.toast('Error al estampar: ' + err.message, 'error');
        }
    },

    _calculatePosition(pageW, pageH, sigW, sigH, margin) {
        const positions = {
            'tl': { x: margin,                 y: pageH - sigH - margin },
            'tc': { x: (pageW - sigW) / 2,     y: pageH - sigH - margin },
            'tr': { x: pageW - sigW - margin,   y: pageH - sigH - margin },
            'ml': { x: margin,                  y: (pageH - sigH) / 2 },
            'mc': { x: (pageW - sigW) / 2,      y: (pageH - sigH) / 2 },
            'mr': { x: pageW - sigW - margin,   y: (pageH - sigH) / 2 },
            'bl': { x: margin,                  y: margin },
            'bc': { x: (pageW - sigW) / 2,      y: margin },
            'br': { x: pageW - sigW - margin,   y: margin },
        };
        return positions[this._position] || positions['bl'];
    },

    _dataURLToBytes(dataURL) {
        const base64 = dataURL.split(',')[1];
        const binary  = atob(base64);
        const bytes   = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
};

// Resize signature canvas on window resize
window.addEventListener('resize', () => {
    if (Signature._pad) Signature.resize();
});
