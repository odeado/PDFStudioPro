/* ============================================================
   app.js — Main Application State & Coordinator
   PDF Studio Pro
   ============================================================ */

const App = {
    // State
    pdfBytes: null,       // Current PDF as Uint8Array
    fileName: '',
    fileSize: 0,
    isFileOpen: false,

    async init() {
        // Configure PDF.js worker
        if (typeof pdfjsLib !== 'undefined') {
            pdfjsLib.GlobalWorkerOptions.workerSrc = window.pdfjsWorkerSrc;
        }

        // Initialize UI responsive state for mobile
        UI.init();

        // Splash animation
        await this._runSplash();

        // Setup drag & drop on viewer section
        this._setupDragDrop();

        // Setup mouse drag panning tool for zoomed PDF view
        this._setupPanTool();

        // Setup merge drop zone
        this._setupMergeDrop();

        // Keyboard shortcut Ctrl+O to open file
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
                e.preventDefault();
                this.openFile();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.saveFile();
            }
        });

        // Show app
        document.getElementById('splash').style.opacity = '0';
        document.getElementById('splash').style.transition = 'opacity 0.5s ease';
        setTimeout(() => {
            document.getElementById('splash').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
        }, 500);

        // Initialize signature module
        Signature.init();
    },

    async _runSplash() {
        const fill   = document.getElementById('splashProgress');
        const status = document.getElementById('splashStatus');
        const steps  = [
            [20, 'Cargando PDF.js...'],
            [40, 'Inicializando pdf-lib...'],
            [60, 'Preparando motor OCR...'],
            [80, 'Configurando interfaz...'],
            [100, '¡Listo!']
        ];
        for (const [pct, msg] of steps) {
            fill.style.width = pct + '%';
            status.textContent = msg;
            await this._sleep(300 + Math.random() * 200);
        }
        await this._sleep(400);
    },

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    _setupDragDrop() {
        const viewerSection = document.getElementById('viewerSection');
        const dropZone = document.getElementById('dropZone');

        ['dragenter', 'dragover'].forEach(evt => {
            viewerSection.addEventListener(evt, (e) => {
                e.preventDefault();
                // Show drag overlay even if a file is already open
                if (this.isFileOpen) {
                    this._showDragOverlay(true);
                } else {
                    dropZone.classList.add('drag-over');
                }
            });
        });

        ['dragleave'].forEach(evt => {
            viewerSection.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                this._showDragOverlay(false);
            });
        });

        viewerSection.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            this._showDragOverlay(false);
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') {
                this.loadPDF(file);
            } else if (file) {
                UI.toast('Solo se admiten archivos PDF', 'error');
            }
        });
    },

    _showDragOverlay(show) {
        let overlay = document.getElementById('dragOverlay');
        if (!overlay && show) {
            overlay = document.createElement('div');
            overlay.id = 'dragOverlay';
            overlay.className = 'drag-overlay';
            overlay.innerHTML = `
                <div class="drag-overlay-inner">
                    <span class="material-icons-round">upload_file</span>
                    <p>Suelta para abrir este PDF</p>
                </div>`;
            document.getElementById('viewerSection').appendChild(overlay);
        } else if (overlay && !show) {
            overlay.remove();
        }
    },

    _setupPanTool() {
        const section = document.getElementById('viewerSection');
        let isPanning = false;
        let startX = 0, startY = 0, scrollLeft = 0, scrollTop = 0;

        section.addEventListener('mousedown', (e) => {
            if (e.target.closest('.pdf-text-box') || e.target.closest('.drop-zone') || e.target.closest('button')) return;
            isPanning = true;
            section.style.cursor = 'grabbing';
            startX = e.pageX - section.offsetLeft;
            startY = e.pageY - section.offsetTop;
            scrollLeft = section.scrollLeft;
            scrollTop = section.scrollTop;
        });

        section.addEventListener('mouseleave', () => { isPanning = false; section.style.cursor = ''; });
        section.addEventListener('mouseup', () => { isPanning = false; section.style.cursor = ''; });

        section.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            e.preventDefault();
            const x = e.pageX - section.offsetLeft;
            const y = e.pageY - section.offsetTop;
            const walkX = (x - startX) * 1.5;
            const walkY = (y - startY) * 1.5;
            section.scrollLeft = scrollLeft - walkX;
            section.scrollTop = scrollTop - walkY;
        });
    },

    _setupMergeDrop() {
        const mergeArea = document.getElementById('mergeDropArea');
        if (!mergeArea) return;

        mergeArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            mergeArea.style.borderColor = 'var(--primary)';
        });
        mergeArea.addEventListener('dragleave', () => {
            mergeArea.style.borderColor = '';
        });
        mergeArea.addEventListener('drop', (e) => {
            e.preventDefault();
            mergeArea.style.borderColor = '';
            const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
            if (files.length) PdfTools.addMergeFilesArray(files);
        });
    },

    openFile() {
        document.getElementById('fileInput').click();
    },

    handleFileInput(input) {
        if (input.files && input.files[0]) {
            this.loadPDF(input.files[0]);
            input.value = '';
        }
    },

    async loadPDF(file) {
        UI.setStatus('Cargando PDF...', 'busy');
        try {
            const arrayBuffer = await file.arrayBuffer();
            this.pdfBytes  = new Uint8Array(arrayBuffer);
            this.fileName  = file.name;
            this.fileSize  = file.size;
            this.isFileOpen = true;

            // Update header
            document.getElementById('headerFileName').textContent = file.name;
            document.getElementById('headerFileName').title = file.name;

            // Update compress panel
            const card = document.getElementById('fileSizeCard');
            if (card) {
                card.style.display = 'block';
                document.getElementById('fileSizeDisplay').textContent = this._formatSize(file.size);
            }

            // Show status
            document.getElementById('statusRight').textContent = this._formatSize(file.size);

            // Load in PDF.js for viewing
            await PDFViewer.load(this.pdfBytes.slice());

            // Switch to viewer
            document.getElementById('dropZone').style.display  = 'none';
            document.getElementById('canvasWrap').style.display = 'flex';

            UI.setStatus(`Archivo cargado — ${file.name}`, 'ok');
            UI.toast(`PDF cargado: ${file.name}`, 'success');

        } catch (err) {
            console.error('Error loading PDF:', err);
            UI.setStatus('Error al cargar el PDF', 'error');
            UI.toast('Error al cargar el PDF: ' + err.message, 'error');
        }
    },

    async saveFile() {
        if (!this.isFileOpen) {
            UI.toast('No hay ningún archivo abierto', 'warning');
            return;
        }
        try {
            // Get latest bytes from pdf-lib if available
            const bytes = PdfTools.currentPdfLib
                ? await PdfTools.currentPdfLib.save()
                : this.pdfBytes;

            this._downloadBytes(bytes, this.fileName || 'documento.pdf', 'application/pdf');
            UI.toast('PDF guardado correctamente', 'success');
        } catch (err) {
            UI.toast('Error al guardar: ' + err.message, 'error');
        }
    },

    _downloadBytes(bytes, filename, mimeType) {
        const blob = new Blob([bytes], { type: mimeType });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    },

    _formatSize(bytes) {
        if (bytes < 1024)       return bytes + ' B';
        if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(2) + ' MB';
    }
};

// Bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());
