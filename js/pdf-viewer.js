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

    // Get current page as image data URL (for OCR)
    async getCurrentPageImage(scale = 2) {
        if (!this._doc) return null;
        const page     = await this._doc.getPage(this._currentPage);
        const viewport = page.getViewport({ scale });
        const canvas   = document.createElement('canvas');
        canvas.width   = Math.floor(viewport.width);
        canvas.height  = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas.toDataURL('image/png');
    },

    // Get specific page as image
    async getPageImage(pageNum, scale = 2) {
        if (!this._doc) return null;
        const page     = await this._doc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const canvas   = document.createElement('canvas');
        canvas.width   = Math.floor(viewport.width);
        canvas.height  = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas.toDataURL('image/png');
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
