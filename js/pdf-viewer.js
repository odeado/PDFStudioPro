/* ============================================================
   pdf-viewer.js — PDF.js Rendering Engine
   PDF Studio Pro
   ============================================================ */

const PDFViewer = {
    _doc:          null,    // PDF.js document
    _currentPage:  1,
    _totalPages:   0,
    _scale:        1.0,
    _renderTask:   null,
    _thumbTasks:   [],

    // ---- Load PDF ----
    async load(pdfBytes) {
        try {
            this._doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
            this._totalPages = this._doc.numPages;
            this._currentPage = 1;

            // Determine initial scale based on viewport
            await this._autoScale();

            // Render first page
            await this.renderPage(1);

            // Generate thumbnails
            this._generateThumbnails();

            // Update UI
            UI.setPageStatus(1, this._totalPages);
            document.getElementById('zoomLevel').textContent =
                Math.round(this._scale * 100) + '%';

        } catch (err) {
            console.error('PDFViewer.load error:', err);
            throw err;
        }
    },

    async _autoScale() {
        const page = await this._doc.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const viewerSection = document.getElementById('viewerSection');
        const availW = viewerSection.clientWidth  - 48;
        const availH = viewerSection.clientHeight - 48;
        const scaleW = availW / viewport.width;
        const scaleH = availH / viewport.height;
        this._scale = Math.min(scaleW, scaleH, 1.5);
        this._scale = Math.max(this._scale, 0.3);
    },

    // ---- Render Page ----
    async renderPage(pageNum) {
        if (!this._doc) return;
        pageNum = Math.max(1, Math.min(pageNum, this._totalPages));
        this._currentPage = pageNum;

        // Cancel previous render
        if (this._renderTask) {
            try { this._renderTask.cancel(); } catch (e) {}
            this._renderTask = null;
        }

        document.getElementById('pageLoading').style.display = 'flex';

        try {
            const page = await this._doc.getPage(pageNum);

            const pixelRatio = window.devicePixelRatio || 1;
            const viewport   = page.getViewport({ scale: this._scale * pixelRatio });

            const canvas  = document.getElementById('pdfCanvas');
            const overlay = document.getElementById('overlayCanvas');
            const ctx     = canvas.getContext('2d');

            const displayWidth  = Math.floor(viewport.width / pixelRatio);
            const displayHeight = Math.floor(viewport.height / pixelRatio);

            canvas.width  = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width  = displayWidth + 'px';
            canvas.style.height = displayHeight + 'px';

            overlay.width  = canvas.width;
            overlay.height = canvas.height;
            overlay.style.width  = canvas.style.width;
            overlay.style.height = canvas.style.height;

            this._renderTask = page.render({
                canvasContext: ctx,
                viewport: viewport
            });

            await this._renderTask.promise;

            // Update thumbnail highlight
            this._highlightThumb(pageNum);

            // Re-render text edit overlay if active
            if (typeof PDFTextEditor !== 'undefined' && PDFTextEditor._active) {
                PDFTextEditor.renderOverlay();
            }

            // Update status
            UI.setPageStatus(pageNum, this._totalPages);
            document.getElementById('zoomLevel').textContent =
                Math.round(this._scale * 100) + '%';

        } catch (err) {
            if (err && err.name !== 'RenderingCancelledException') {
                console.error('Render error:', err);
            }
        } finally {
            document.getElementById('pageLoading').style.display = 'none';
        }
    },

    // ---- Navigation ----
    prevPage() {
        if (this._currentPage > 1) this.renderPage(this._currentPage - 1);
    },

    nextPage() {
        if (this._currentPage < this._totalPages) this.renderPage(this._currentPage + 1);
    },

    goToPage(num) {
        const n = parseInt(num);
        if (!isNaN(n) && n >= 1 && n <= this._totalPages) {
            this.renderPage(n);
        } else {
            document.getElementById('pageInput').value = this._currentPage;
        }
    },

    // ---- Zoom ----
    zoom(delta) {
        const newScale = Math.max(0.25, Math.min(4, this._scale + delta));
        if (newScale !== this._scale) {
            this._scale = newScale;
            this.renderPage(this._currentPage);
        }
    },

    async fitToPage() {
        await this._autoScale();
        this.renderPage(this._currentPage);
    },

    // ---- Thumbnails ----
    async _generateThumbnails() {
        const container = document.getElementById('thumbnailsContainer');
        container.innerHTML = '';

        for (let i = 1; i <= this._totalPages; i++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'thumb-item' + (i === 1 ? ' active' : '');
            wrapper.dataset.page = i;
            wrapper.onclick = () => this.renderPage(i);

            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.style.width  = '100%';
            thumbCanvas.style.display = 'block';

            const numLabel = document.createElement('div');
            numLabel.className = 'thumb-page-num';
            numLabel.textContent = i;

            wrapper.appendChild(thumbCanvas);
            wrapper.appendChild(numLabel);
            container.appendChild(wrapper);

            // Render thumbnail (small scale)
            this._renderThumb(i, thumbCanvas).catch(() => {});
        }
    },

    async _renderThumb(pageNum, canvas) {
        if (!this._doc) return;
        try {
            const page     = await this._doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 0.18 });
            const pixelRatio = window.devicePixelRatio || 1;

            canvas.width  = Math.floor(viewport.width  * pixelRatio);
            canvas.height = Math.floor(viewport.height * pixelRatio);
            canvas.style.width  = viewport.width  + 'px';
            canvas.style.height = viewport.height + 'px';

            const ctx = canvas.getContext('2d');
            ctx.scale(pixelRatio, pixelRatio);

            await page.render({ canvasContext: ctx, viewport }).promise;
        } catch (e) {}
    },

    _highlightThumb(pageNum) {
        document.querySelectorAll('.thumb-item').forEach(t => {
            t.classList.toggle('active', parseInt(t.dataset.page) === pageNum);
        });
        // Scroll thumbnail into view
        const active = document.querySelector('.thumb-item.active');
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },

    // ---- Helpers ----
    getCurrentPage()  { return this._currentPage; },
    getTotalPages()   { return this._totalPages; },
    getScale()        { return this._scale; },
    getDoc()          { return this._doc; },

    // Get current page rendered onto a canvas (for OCR). Returns the canvas
    // itself (not just a data URL) so callers can enhance pixels before
    // handing it to Tesseract.
    async getCurrentPageImage(scale = 2) {
        return this.getPageImage(this._currentPage, scale);
    },

    // Get specific page as a canvas + dimensions
    async getPageImage(pageNum, scale = 2) {
        if (!this._doc) return null;
        const page     = await this._doc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas   = document.createElement('canvas');
        canvas.width   = Math.floor(viewport.width);
        canvas.height  = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        return { canvas, width: canvas.width, height: canvas.height };
    },

    // ---- Extract embedded raster images (logos, photos, signatures) from a
    // native-text page, so they aren't silently dropped by the Word export.
    // Best-effort: any image that fails to decode is skipped rather than
    // aborting the whole page.
    async getPageImages(pageNum) {
        if (!this._doc) return [];
        try {
            const page = await this._doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1 });

            // Ensure pdf.js has decoded this page's image XObjects into
            // page.objs before we try to read them back out synchronously.
            const dummy = document.createElement('canvas');
            dummy.width  = Math.max(1, Math.floor(viewport.width));
            dummy.height = Math.max(1, Math.floor(viewport.height));
            try {
                await page.render({ canvasContext: dummy.getContext('2d'), viewport }).promise;
            } catch (e) { /* best effort */ }

            const OPS = (typeof pdfjsLib !== 'undefined' && pdfjsLib.OPS) || {};
            const opList = await page.getOperatorList();

            const mul = (m1, m2) => [
                m1[0]*m2[0] + m1[1]*m2[2],         m1[0]*m2[1] + m1[1]*m2[3],
                m1[2]*m2[0] + m1[3]*m2[2],         m1[2]*m2[1] + m1[3]*m2[3],
                m1[4]*m2[0] + m1[5]*m2[2] + m2[4], m1[4]*m2[1] + m1[5]*m2[3] + m2[5]
            ];

            let stack = [[1, 0, 0, 1, 0, 0]];
            const found = [];
            const seen = new Set();

            for (let i = 0; i < opList.fnArray.length; i++) {
                const fn = opList.fnArray[i];
                const args = opList.argsArray[i];
                const top = stack[stack.length - 1];

                if (fn === OPS.save) {
                    stack.push(top.slice());
                } else if (fn === OPS.restore) {
                    if (stack.length > 1) stack.pop();
                } else if (fn === OPS.transform) {
                    stack[stack.length - 1] = mul(args, top);
                } else if (fn === OPS.paintFormXObjectBegin) {
                    stack.push(mul(args[0] || [1, 0, 0, 1, 0, 0], top));
                } else if (fn === OPS.paintFormXObjectEnd) {
                    if (stack.length > 1) stack.pop();
                } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                    const objId = args[0];
                    if (!objId || seen.has(objId)) continue;
                    seen.add(objId);

                    const ctm = top;
                    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
                        ctm[0]*x + ctm[2]*y + ctm[4],
                        ctm[1]*x + ctm[3]*y + ctm[5]
                    ]);
                    const xs = corners.map(c => c[0]);
                    const ys = corners.map(c => c[1]);
                    const x0 = Math.min(...xs), x1 = Math.max(...xs);
                    const y0 = Math.min(...ys), y1 = Math.max(...ys);
                    const wPt = x1 - x0, hPt = y1 - y0;

                    // Skip tiny/decorative specks (bullets, icons)
                    if (!(wPt >= 20 && hPt >= 20)) continue;

                    try {
                        const imgObj = page.objs.get(objId);
                        const png = this._imageObjToPng(imgObj);
                        if (png) {
                            found.push({
                                bytes: png.bytes,
                                pxWidth: png.width,
                                pxHeight: png.height,
                                xPt: x0,
                                yPt: viewport.height - y1, // top-left origin
                                wPt, hPt
                            });
                        }
                    } catch (e) { /* skip images we can't decode */ }
                }
            }

            found.sort((a, b) => a.yPt - b.yPt);
            return found;
        } catch (e) {
            console.warn('getPageImages failed:', e);
            return [];
        }
    },

    // Convert a pdf.js image object (raw pixel buffer or ImageBitmap) into PNG bytes.
    _imageObjToPng(img) {
        if (!img) return null;
        const canvas = document.createElement('canvas');

        if (img.bitmap) {
            canvas.width  = img.bitmap.width;
            canvas.height = img.bitmap.height;
            canvas.getContext('2d').drawImage(img.bitmap, 0, 0);
        } else if (img.data && img.width && img.height) {
            canvas.width  = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(img.width, img.height);
            const src = img.data;
            const dst = imageData.data;
            const total = img.width * img.height;

            if (src.length === total * 4) {
                dst.set(src);
            } else if (src.length === total * 3) {
                for (let p = 0; p < total; p++) {
                    dst[p*4]   = src[p*3];
                    dst[p*4+1] = src[p*3+1];
                    dst[p*4+2] = src[p*3+2];
                    dst[p*4+3] = 255;
                }
            } else if (src.length === Math.ceil(img.width / 8) * img.height) {
                // 1-bit-per-pixel packed grayscale/mask
                const rowBytes = Math.ceil(img.width / 8);
                for (let y = 0; y < img.height; y++) {
                    for (let x = 0; x < img.width; x++) {
                        const byte = src[y * rowBytes + (x >> 3)];
                        const bit  = (byte >> (7 - (x & 7))) & 1;
                        const v = bit ? 255 : 0;
                        const p = (y * img.width + x) * 4;
                        dst[p] = v; dst[p+1] = v; dst[p+2] = v; dst[p+3] = 255;
                    }
                }
            } else {
                return null; // unrecognized pixel format
            }
            ctx.putImageData(imageData, 0, 0);
        } else {
            return null;
        }

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return { bytes, width: canvas.width, height: canvas.height };
    },

    // Extract structured text elements with exact canvas pixel coordinates for overlay
    async getStructuredPageText(pageNum) {
        if (!this._doc) return null;
        try {
            const page = await this._doc.getPage(pageNum);
            const textContent = await page.getTextContent();
            const currentScale = this._scale;
            const viewport = page.getViewport({ scale: currentScale });

            if (!textContent.items || textContent.items.length === 0) return null;

            const items = textContent.items
                .filter(item => item.str && item.str.trim().length > 0)
                .map(item => {
                    const tx = item.transform;
                    const pdfX = tx[4];
                    const pdfY = tx[5];
                    const fontH = Math.abs(tx[3]) || Math.abs(tx[0]) || 12;
                    const fontName = (item.fontName || '').toLowerCase();
                    const isBold = fontName.includes('bold') || fontName.includes('black') || fontName.includes('heavy') || fontName.includes('b=1');
                    const isItalic = fontName.includes('italic') || fontName.includes('oblique');

                    // Convert PDF baseline (bottom-left) to Canvas pixels (top-left)
                    const [px, pyBaseline] = viewport.convertToViewportPoint(pdfX, pdfY);
                    const pxTop = pyBaseline - (fontH * currentScale * 0.85);

                    return {
                        text: item.str,
                        pdfX: pdfX,
                        pdfY: pdfY,
                        fontH: fontH,
                        fontName: item.fontName,
                        isBold: isBold,
                        isItalic: isItalic,
                        px: px,
                        py: pxTop,
                        pw: item.width * currentScale,
                        ph: fontH * currentScale * 1.1
                    };
                });

            return { items, viewportWidth: viewport.width, viewportHeight: viewport.height, scale: currentScale };
        } catch (e) {
            return null;
        }
    },

    // Reload after PDF modification
    async reload(newPdfBytes) {
        const currentPage = this._currentPage;
        App.pdfBytes = new Uint8Array(newPdfBytes);
        await this.load(App.pdfBytes.slice());
        const page = Math.min(currentPage, this._totalPages);
        await this.renderPage(page);
    }
};
