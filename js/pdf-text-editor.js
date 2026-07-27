/* ============================================================
   pdf-text-editor.js — Direct Inline PDF Text Editor
   Allows editing names, dates, numbers directly on the PDF canvas
   PDF Studio Pro
   ============================================================ */

const PDFTextEditor = {
    _active: false,
    _editedItems: [], // Array of { pageNum, originalText, newText, x, y, w, h, fontSize }

    async toggleEditMode() {
        if (!App.isFileOpen) {
            UI.toast('Abre un PDF primero', 'warning');
            return;
        }

        this._active = !this._active;
        const btn = document.getElementById('btnToggleTextEdit');
        const vtab = document.getElementById('vtab-edit');

        if (btn) btn.classList.toggle('active', this._active);
        if (vtab) vtab.classList.toggle('active', this._active);

        if (this._active) {
            UI.setStatus('Modo Edición Directa activo — Clic sobre cualquier texto para editar', 'busy');
            UI.toast('Clic en cualquier texto sobre la pantalla para editarlo', 'info');
            await this.renderOverlay();
        } else {
            this.clearOverlay();
            UI.setStatus('Modo edición cerrado', 'ok');
        }
    },

    async renderOverlay() {
        this.clearOverlay();
        if (!this._active) return;

        const pageNum = PDFViewer.getCurrentPage();
        const struct = await PDFViewer.getStructuredPageText(pageNum);

        if (!struct || !struct.items || struct.items.length === 0) {
            UI.toast('No se detectaron textos vectoriales en esta página. Si es una imagen escaneada, usa la pestaña OCR.', 'warning');
            return;
        }

        const canvasInner = document.getElementById('canvasInner');
        const canvas = document.getElementById('pdfCanvas');
        const canvasCtx = canvas.getContext('2d');
        // The overlay boxes are positioned in the canvas's CSS/display pixel
        // space, but the canvas's actual pixel buffer is bigger by the device
        // pixel ratio — need this to sample the right region for ink color.
        const sampleScale = canvas.width / (canvas.clientWidth || parseFloat(canvas.style.width) || canvas.width);

        const overlayContainer = document.createElement('div');
        overlayContainer.id = 'textEditOverlay';
        overlayContainer.className = 'text-edit-overlay';
        overlayContainer.style.width  = canvas.style.width;
        overlayContainer.style.height = canvas.style.height;

        struct.items.forEach((item) => {
            if (!item.text.trim()) return;

            const box = document.createElement('div');
            box.className = 'pdf-text-box';
            box.contentEditable = 'true';
            box.innerText = item.text;

            box.style.left      = Math.round(item.px) + 'px';
            box.style.top       = Math.round(item.py) + 'px';
            box.style.width     = Math.max(Math.round(item.pw) + 6, 20) + 'px';
            box.style.height    = Math.max(Math.round(item.ph), 14) + 'px';
            box.style.fontSize  = Math.max(Math.round(item.fontH * struct.scale), 10) + 'px';

            // Sample the actual rendered ink color under this text, so edits
            // to colored text (red invoice headers, etc.) don't get flattened
            // to black when written back into the PDF.
            const inkColor = this._sampleInkColor(canvasCtx, canvas, item.px, item.py, item.pw, item.ph, sampleScale);

            box.onblur = () => {
                const newText = box.innerText.trim();
                if (newText !== item.text.trim()) {
                    box.classList.add('modified');
                    this._registerEdit({
                        pageNum,
                        originalText: item.text,
                        newText: newText,
                        x: item.pdfX,
                        y: item.pdfY,
                        w: item.pw / struct.scale,
                        h: item.fontH,
                        fontSize: item.fontH,
                        isBold: item.isBold,
                        isItalic: item.isItalic,
                        color: inkColor
                    });
                }
            };

            overlayContainer.appendChild(box);
        });

        canvasInner.appendChild(overlayContainer);
        const actions = document.getElementById('textEditActions');
        if (actions) actions.style.display = 'flex';
    },

    // Read the actual rendered pixels under a text item and return the
    // darkest ("most ink-like") color found — this is the item's real color
    // (red, blue, black...) as it appears on the page, without needing to
    // parse the PDF's content-stream color operators.
    _sampleInkColor(ctx, canvas, pxLeft, pyTop, pw, ph, sampleScale) {
        try {
            const bx = Math.max(0, Math.round(pxLeft * sampleScale));
            const by = Math.max(0, Math.round(pyTop * sampleScale));
            const bw = Math.min(canvas.width  - bx, Math.max(1, Math.round(pw * sampleScale)));
            const bh = Math.min(canvas.height - by, Math.max(1, Math.round(ph * sampleScale)));
            if (bw <= 0 || bh <= 0) return null;

            const { data } = ctx.getImageData(bx, by, bw, bh);
            let best = null, bestLum = 256;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i + 1], b = data[i + 2];
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                if (lum < bestLum) {
                    bestLum = lum;
                    best = { r, g, b };
                }
            }

            // If the darkest pixel found is still near-white, this box is
            // probably blank/whitespace — not a reliable color sample.
            if (!best || bestLum > 200) return null;
            return best;
        } catch (e) {
            return null;
        }
    },

    clearOverlay() {
        const overlay = document.getElementById('textEditOverlay');
        if (overlay) overlay.remove();
        const actions = document.getElementById('textEditActions');
        if (actions) actions.style.display = 'none';
    },

    _registerEdit(editObj) {
        const existingIdx = this._editedItems.findIndex(e =>
            e.pageNum === editObj.pageNum && Math.abs(e.x - editObj.x) < 5 && Math.abs(e.y - editObj.y) < 5
        );
        if (existingIdx >= 0) {
            this._editedItems[existingIdx] = editObj;
        } else {
            this._editedItems.push(editObj);
        }
        UI.toast('Cambio de texto registrado. Clic en "Aplicar Cambios" para guardar en el PDF.', 'info');
    },

    async applyEditsToPDF() {
        if (this._editedItems.length === 0) {
            UI.toast('No has modificado ningún texto aún', 'warning');
            return;
        }

        UI.setStatus('Guardando cambios en el archivo PDF...', 'busy');

        try {
            const doc = await PDFLib.PDFDocument.load(App.pdfBytes, { ignoreEncryption: true });

            // Embed font variations
            const fontNormal     = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
            const fontBold       = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
            const fontItalic     = await doc.embedFont(PDFLib.StandardFonts.HelveticaOblique);
            const fontBoldItalic = await doc.embedFont(PDFLib.StandardFonts.HelveticaBoldOblique);

            const pages = doc.getPages();

            for (const edit of this._editedItems) {
                const page = pages[edit.pageNum - 1];

                // Select matching font weight/style
                let font = fontNormal;
                if (edit.isBold && edit.isItalic) font = fontBoldItalic;
                else if (edit.isBold)            font = fontBold;
                else if (edit.isItalic)          font = fontItalic;

                const fontSize = Math.max(edit.fontSize, 8);
                const rectW    = Math.max(edit.w + 6, 25);
                const rectH    = fontSize * 1.25;
                const rectY    = edit.y - (fontSize * 0.25);

                // 1. Cover original text area with white rectangle
                page.drawRectangle({
                    x: Math.max(edit.x - 1, 0),
                    y: Math.max(rectY, 0),
                    width: rectW,
                    height: rectH,
                    color: PDFLib.rgb(1, 1, 1),
                });

                // 2. Draw modified text at exact baseline y, in the same ink
                // color the original text had (falls back to black if we
                // couldn't sample it, e.g. edited box was blank before).
                const c = edit.color || { r: 0, g: 0, b: 0 };
                page.drawText(edit.newText, {
                    x: edit.x,
                    y: edit.y,
                    size: fontSize,
                    font: font,
                    color: PDFLib.rgb(c.r / 255, c.g / 255, c.b / 255),
                });
            }

            const newBytes = await doc.save();
            this._editedItems = [];
            this.clearOverlay();
            this._active = false;

            await PDFViewer.reload(newBytes);
            App.pdfBytes = new Uint8Array(newBytes);

            UI.setStatus('Texto actualizado en el PDF', 'ok');
            UI.toast('¡Texto guardado en el PDF con tipografía y posición exacta!', 'success');

        } catch (err) {
            console.error('Apply text edit error:', err);
            UI.setStatus('Error al guardar texto', 'error');
            UI.toast('Error al guardar: ' + err.message, 'error');
        }
    }
};
