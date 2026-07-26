/* ============================================================
   pdf-tools.js — PDF Manipulation with pdf-lib
   Rotate, Merge, Split, Delete pages, Compress
   PDF Studio Pro
   ============================================================ */

const PdfTools = {
    currentPdfLib: null,   // pdf-lib PDFDocument (active)
    _mergeFiles:   [],     // Array of {name, size, bytes} for merge
    _compressLevel: 'medium',

    // ---- Load active PDF into pdf-lib ----
    async _getDoc() {
        if (!App.isFileOpen) {
            UI.toast('Abre un PDF primero', 'warning');
            return null;
        }
        try {
            // Always reload from current bytes to catch external changes
            const doc = await PDFLib.PDFDocument.load(App.pdfBytes, {
                ignoreEncryption: true
            });
            this.currentPdfLib = doc;
            return doc;
        } catch (err) {
            UI.toast('Error al procesar el PDF: ' + err.message, 'error');
            return null;
        }
    },

    async _saveAndReload(doc, actionName) {
        try {
            UI.setStatus(`Guardando cambios...`, 'busy');
            const bytes = await doc.save();
            this.currentPdfLib = doc;

            // Update app bytes and reload viewer
            await PDFViewer.reload(bytes);
            App.pdfBytes = new Uint8Array(bytes);

            UI.setStatus(`${actionName} — listo`, 'ok');
            UI.toast(actionName + ' aplicado correctamente', 'success');
        } catch (err) {
            UI.setStatus('Error al guardar', 'error');
            UI.toast('Error: ' + err.message, 'error');
        }
    },

    // ====================================================
    // ROTATE
    // ====================================================
    async rotatePage(degrees) {
        const doc = await this._getDoc();
        if (!doc) return;

        const pages = doc.getPages();
        const idx   = PDFViewer.getCurrentPage() - 1;
        if (idx < 0 || idx >= pages.length) return;

        const page = pages[idx];
        const current = page.getRotation().angle;
        const newAngle = ((current + degrees) % 360 + 360) % 360;
        page.setRotation(PDFLib.degrees(newAngle));

        await this._saveAndReload(doc, `Página rotada ${degrees > 0 ? degrees + '°' : Math.abs(degrees) + '° izquierda'}`);
    },

    async rotateAll(degrees) {
        const doc = await this._getDoc();
        if (!doc) return;

        for (const page of doc.getPages()) {
            const current = page.getRotation().angle;
            const newAngle = ((current + degrees) % 360 + 360) % 360;
            page.setRotation(PDFLib.degrees(newAngle));
        }

        await this._saveAndReload(doc, 'Todo el documento rotado');
    },

    // ====================================================
    // DELETE PAGE
    // ====================================================
    async deletePage() {
        const doc = await this._getDoc();
        if (!doc) return;

        const total = doc.getPageCount();
        if (total <= 1) {
            UI.toast('No se puede eliminar la única página del documento', 'warning');
            return;
        }

        const idx = PDFViewer.getCurrentPage() - 1;
        doc.removePage(idx);

        await this._saveAndReload(doc, `Página ${idx + 1} eliminada`);
    },

    // ====================================================
    // EXTRACT SINGLE PAGE
    // ====================================================
    async extractPage() {
        const doc = await this._getDoc();
        if (!doc) return;

        const idx     = PDFViewer.getCurrentPage() - 1;
        const newDoc  = await PDFLib.PDFDocument.create();
        const [page]  = await newDoc.copyPages(doc, [idx]);
        newDoc.addPage(page);

        const bytes = await newDoc.save();
        const name  = App.fileName.replace('.pdf', '') + `_pagina_${idx + 1}.pdf`;
        App._downloadBytes(bytes, name, 'application/pdf');
        UI.toast(`Página ${idx + 1} extraída como "${name}"`, 'success');
    },

    // ====================================================
    // EXTRACT RANGE OF PAGES
    // ====================================================
    async extractRange() {
        const doc = await this._getDoc();
        if (!doc) return;

        const input = document.getElementById('pageRange').value.trim();
        if (!input) { UI.toast('Ingresa un rango de páginas', 'warning'); return; }

        const total = doc.getPageCount();
        const indices = this._parsePageRange(input, total);

        if (indices.length === 0) {
            UI.toast('Rango de páginas inválido', 'error');
            return;
        }

        const newDoc = await PDFLib.PDFDocument.create();
        const pages  = await newDoc.copyPages(doc, indices);
        pages.forEach(p => newDoc.addPage(p));

        const bytes = await newDoc.save();
        const name  = App.fileName.replace('.pdf', '') + `_extraido.pdf`;
        App._downloadBytes(bytes, name, 'application/pdf');
        UI.toast(`${indices.length} página(s) extraídas como "${name}"`, 'success');
    },

    _parsePageRange(rangeStr, totalPages) {
        const indices = new Set();
        const parts   = rangeStr.split(',');

        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes('-')) {
                const [startStr, endStr] = trimmed.split('-');
                const start = parseInt(startStr.trim());
                const end   = parseInt(endStr.trim());
                if (!isNaN(start) && !isNaN(end)) {
                    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                        if (i >= 1 && i <= totalPages) indices.add(i - 1);
                    }
                }
            } else {
                const n = parseInt(trimmed);
                if (!isNaN(n) && n >= 1 && n <= totalPages) indices.add(n - 1);
            }
        }

        return Array.from(indices).sort((a, b) => a - b);
    },

    // ====================================================
    // MERGE PDFs
    // ====================================================
    addMergeFilesArray(files) {
        files.forEach(file => {
            const reader = new FileReader();
            reader.onload = (e) => {
                this._mergeFiles.push({
                    name:  file.name,
                    size:  file.size,
                    bytes: new Uint8Array(e.target.result)
                });
                this._renderMergeList();
            };
            reader.readAsArrayBuffer(file);
        });
    },

    handleMergeInput(input) {
        if (input.files) {
            this.addMergeFilesArray(Array.from(input.files));
            input.value = '';
        }
    },

    _renderMergeList() {
        const list = document.getElementById('mergeFileList');
        const actions = document.getElementById('mergeActions');
        list.innerHTML = '';

        this._mergeFiles.forEach((f, idx) => {
            const item = document.createElement('div');
            item.className = 'merge-file-item';
            item.innerHTML = `
                <span class="material-icons-round">picture_as_pdf</span>
                <span class="merge-file-name" title="${f.name}">${f.name}</span>
                <span class="merge-file-size">${App._formatSize(f.size)}</span>
                <button class="merge-remove-btn" onclick="PdfTools.removeMergeFile(${idx})" title="Quitar">
                    <span class="material-icons-round">close</span>
                </button>
            `;
            list.appendChild(item);
        });

        actions.style.display = this._mergeFiles.length >= 2 ? 'flex' : 'none';
    },

    removeMergeFile(idx) {
        this._mergeFiles.splice(idx, 1);
        this._renderMergeList();
    },

    clearMerge() {
        this._mergeFiles = [];
        this._renderMergeList();
    },

    async mergePDFs() {
        if (this._mergeFiles.length < 2) {
            UI.toast('Agrega al menos 2 archivos para unir', 'warning');
            return;
        }

        UI.setStatus('Uniendo PDFs...', 'busy');
        UI.toast('Uniendo documentos, por favor espera...', 'info');

        try {
            const merged = await PDFLib.PDFDocument.create();

            for (const file of this._mergeFiles) {
                const srcDoc = await PDFLib.PDFDocument.load(file.bytes, { ignoreEncryption: true });
                const pageCount = srcDoc.getPageCount();
                const copiedPages = await merged.copyPages(srcDoc, [...Array(pageCount).keys()]);
                copiedPages.forEach(p => merged.addPage(p));
            }

            const bytes = await merged.save();
            const name  = 'documento_unido.pdf';
            App._downloadBytes(bytes, name, 'application/pdf');
            UI.setStatus('PDFs unidos correctamente', 'ok');
            UI.toast(`¡${this._mergeFiles.length} archivos unidos! Descargando "${name}"`, 'success');

            // Optionally load merged into viewer
            if (confirm('¿Cargar el documento unido en el visor?')) {
                const file = new File([bytes], name, { type: 'application/pdf' });
                App.loadPDF(file);
                this.clearMerge();
            }
        } catch (err) {
            console.error('Merge error:', err);
            UI.setStatus('Error al unir PDFs', 'error');
            UI.toast('Error al unir: ' + err.message, 'error');
        }
    },

    // ====================================================
    // COMPRESS
    // ====================================================
    setCompressLevel(btn) {
        document.querySelectorAll('.compress-level-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._compressLevel = btn.dataset.level;
    },

    async compress() {
        const doc = await this._getDoc();
        if (!doc) return;

        UI.setStatus('Comprimiendo PDF...', 'busy');
        UI.toast('Comprimiendo...', 'info');

        try {
            // pdf-lib's save() with objectsPerTick and various options
            const saveOptions = {
                useObjectStreams: this._compressLevel !== 'light',
                addDefaultPage:   false,
                objectsPerTick:   50,
            };

            // For 'heavy' compression: remove metadata and compress streams
            if (this._compressLevel === 'heavy') {
                doc.setTitle('');
                doc.setAuthor('');
                doc.setSubject('');
                doc.setKeywords([]);
                doc.setProducer('PDF Studio Pro');
                doc.setCreator('PDF Studio Pro');
            }

            const bytes    = await doc.save(saveOptions);
            const origSize = App.fileSize;
            const newSize  = bytes.length;
            const ratio    = ((1 - newSize / origSize) * 100).toFixed(1);

            const baseName = App.fileName.replace('.pdf', '');
            const name     = `${baseName}_comprimido.pdf`;
            App._downloadBytes(bytes, name, 'application/pdf');

            const msg = ratio > 0
                ? `Comprimido ${ratio}% — ${App._formatSize(origSize)} → ${App._formatSize(newSize)}`
                : `PDF guardado (${App._formatSize(newSize)}) — ya estaba optimizado`;

            UI.setStatus(msg, 'ok');
            UI.toast(msg, 'success');

        } catch (err) {
            UI.setStatus('Error al comprimir', 'error');
            UI.toast('Error al comprimir: ' + err.message, 'error');
        }
    }
};
