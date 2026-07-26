/* ============================================================
   word-export.js — Advanced Layout-Preserving Word Export (.docx)
   Preserves multi-column layout (experience, company/duties, tables)
   PDF Studio Pro
   ============================================================ */

const WordExport = {

    // ---- Export to .docx ----
    async export() {
        const text = OCREngine.getText();
        if (!text && !App.isFileOpen) {
            UI.toast('Abre un PDF o ejecuta el OCR primero', 'warning');
            return;
        }

        UI.setStatus('Generando documento Word con formato exacto...', 'busy');

        try {
            // Try extracting native layout directly from PDF.js if available
            let docxBytes = null;
            const pdfDoc = PDFViewer.getDoc();

            if (pdfDoc) {
                try {
                    docxBytes = await this._buildDocxFromPDFDoc(pdfDoc);
                } catch (e) {
                    console.warn('Native PDF extraction fallback to OCR text parser:', e);
                }
            }

            if (!docxBytes) {
                docxBytes = await this._buildDocxFromText(text || '');
            }

            const baseName = App.fileName ? App.fileName.replace('.pdf', '') : 'documento';
            App._downloadBytes(docxBytes, baseName + '.docx',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

            UI.setStatus('Documento Word exportado con formato de columnas', 'ok');
            UI.toast('Exportado como "' + baseName + '.docx"', 'success');
        } catch (err) {
            console.error('Word export error:', err);
            UI.setStatus('Error al exportar a Word', 'error');
            UI.toast('Error al exportar: ' + err.message, 'error');
        }
    },

    // ---- Export to plain text ----
    exportTxt() {
        const text = OCREngine.getText();
        if (!text.trim()) {
            UI.toast('Primero ejecuta el OCR para extraer texto', 'warning');
            return;
        }
        const baseName = App.fileName ? App.fileName.replace('.pdf', '') : 'documento';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = baseName + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        UI.toast('Guardado como "' + baseName + '.txt"', 'success');
    },

    // ---- Build Word doc from PDF.js Native Text Layer (Coordinates & Columns) ----
    async _buildDocxFromPDFDoc(pdfDoc) {
        const totalPages = pdfDoc.numPages;
        const allNodes = [];

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (pageNum > 1) {
                allNodes.push({ type: 'pageBreak' });
            }

            const struct = await PDFViewer.getStructuredPageText(pageNum);
            let items = null, pageW = 0, pageH = 0;

            if (struct && struct.items && struct.items.length > 0) {
                items = struct.items;
                pageW = struct.viewportWidth;
                pageH = struct.viewportHeight;
            } else if (typeof OCREngine !== 'undefined') {
                // No native text layer on this page (likely scanned) — reuse the
                // OCR's positional data if that page has already been recognized.
                const ocrPage = OCREngine.getPageStructure(pageNum);
                if (ocrPage && ocrPage.items.length > 0) {
                    items = ocrPage.items;
                    pageW = ocrPage.width;
                    pageH = ocrPage.height;
                }
            }

            if (!items) continue;

            const pageImages = await this._safeGetPageImages(pageNum);

            const pageNodes = this._processPageItems(items, pageW, pageH);

            // Cheap diagnostic: a giant run-on paragraph almost always means the
            // line-grouping threshold got fooled by unusual per-item metrics on
            // this particular PDF. Doesn't change behavior, just surfaces it.
            const suspect = pageNodes.find(n => n.type === 'paragraph' && n.text && n.text.length > 350);
            if (suspect && items.length > 15) {
                console.warn(`Word export: page ${pageNum} produced a suspiciously long single block ` +
                    `(${suspect.text.length} chars from ${items.length} items) — layout detection may have failed.`);
            }

            allNodes.push(...pageNodes);
            if (pageImages && pageImages.length) {
                allNodes.push({ type: 'imageCaption', text: 'Imágenes de esta página' });
                pageImages.forEach(img => allNodes.push({ type: 'image', ...img }));
            }
        }

        if (allNodes.length === 0) return null;

        return this._generateOpenXmlZip(allNodes);
    },

    async _safeGetPageImages(pageNum) {
        try {
            if (typeof PDFViewer.getPageImages !== 'function') return null;
            return await PDFViewer.getPageImages(pageNum);
        } catch (e) {
            console.warn('Image extraction failed for page', pageNum, e);
            return null;
        }
    },

    // Process positional items into structured rows, columns, headings.
    // `items` use the {px, py, pw, ph, text} pixel-space convention shared by
    // PDFViewer.getStructuredPageText() (native text) and OCREngine.getPageStructure()
    // (recognized scans), so the same layout heuristics apply to both sources.
    _processPageItems(items, pageW, pageH) {
        // Estimate a typical line height from the items themselves, so the
        // line-grouping threshold isn't a magic pixel constant that breaks at
        // different zoom levels / OCR capture scales.
        const heights = items.map(it => it.ph).filter(h => h > 0).sort((a, b) => a - b);
        const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
        // Bound the threshold two ways in addition to the font-size estimate:
        // some PDF producers emit unusual/oversized font-matrix values, which
        // would otherwise inflate this threshold enough to merge the entire
        // page into one line. Capping it against an absolute pixel limit and
        // against the page's own height keeps grouping safe even when the
        // font-size signal can't be trusted.
        const lineThreshold = Math.max(4, Math.min(medianH * 0.65, 26, pageH * 0.02 || 26));

        // Group items into lines by Y position
        items.sort((a, b) => a.py - b.py || a.px - b.px);

        const lines = [];
        let currentLine = null;

        for (const item of items) {
            const cleanText = item.text.trim();
            if (!cleanText) continue;

            if (!currentLine || Math.abs(item.py - currentLine.y) > lineThreshold) {
                currentLine = { y: item.py, items: [item] };
                lines.push(currentLine);
            } else {
                currentLine.items.push(item);
            }
        }

        // Sort items inside each line left to right
        lines.forEach(line => line.items.sort((a, b) => a.px - b.px));

        // Analyze lines for 2-column blocks
        const nodes = [];
        let tableRows = [];

        const flushTable = () => {
            if (tableRows.length > 0) {
                nodes.push({ type: 'table', rows: tableRows });
                tableRows = [];
            }
        };

        const midX = pageW * 0.38; // Left/Right column boundary
        // Font-size signal for headings, expressed relative to the page's own
        // median line height (same sanity cap as lineThreshold, since a bad
        // font-matrix reading would otherwise flag ordinary lines as headings).
        const safeMedianH = Math.min(medianH, pageH * 0.03 || medianH);
        const headingH = safeMedianH * 1.3;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineText = line.items.map(it => it.text).join(' ').trim();

            if (!lineText) continue;

            // Check if centered title (top of page or large font)
            const minX = line.items[0].px;
            const lastItem = line.items[line.items.length - 1];
            const maxX = lastItem.px + lastItem.pw;
            const lineCenter = (minX + maxX) / 2;
            const pageCenter = pageW / 2;
            const isCentered = Math.abs(lineCenter - pageCenter) < pageW * 0.09 && minX > pageW * 0.12;
            const lineH = Math.max(...line.items.map(it => it.ph || 0));
            const isLargeFont = lineH >= headingH && lineText.length < 70;

            if (isCentered && lineText.length < 60) {
                flushTable();
                nodes.push({
                    type: 'title',
                    text: lineText,
                    isMain: (nodes.length === 0)
                });
                continue;
            }

            // Check if section heading — either matches known heading vocabulary,
            // or is geometrically distinct (noticeably larger than body text).
            if (this._isSectionHeading(lineText) || (isLargeFont && i > 0)) {
                flushTable();
                nodes.push({ type: 'heading', text: lineText });
                continue;
            }

            // Check if items split across Left and Right columns
            const leftItems  = line.items.filter(it => it.px < midX);
            const rightItems = line.items.filter(it => it.px >= midX);

            if (leftItems.length > 0 && rightItems.length > 0) {
                tableRows.push({
                    col1: leftItems.map(it => it.text).join(' ').trim(),
                    col2: rightItems.map(it => it.text).join(' ').trim()
                });
                continue;
            }

            // Check key-value pattern (e.g. "RUT: 14.110.640-6")
            const kvMatch = lineText.match(/^([A-ZÁÉÍÓÚÑa-záéíóúñ0-9\s,\.\/ºN°\-]{2,35}:)\s*(.+)$/);
            if (kvMatch) {
                tableRows.push({
                    col1: kvMatch[1].trim(),
                    col2: kvMatch[2].trim()
                });
                continue;
            }

            // Regular line
            if (leftItems.length > 0 && rightItems.length === 0 && tableRows.length > 0) {
                // Continuation of left column in existing table row or new row
                const lastRow = tableRows[tableRows.length - 1];
                if (lastRow && !lastRow.col2) {
                    lastRow.col1 += ' ' + lineText;
                    continue;
                }
            }

            flushTable();
            nodes.push({ type: 'paragraph', text: lineText });
        }

        flushTable();
        return nodes;
    },

    // ---- Fallback Text Parser (Handles multi-column experience blocks) ----
    async _buildDocxFromText(rawText) {
        const nodes = this._parseTextToNodes(rawText);
        return this._generateOpenXmlZip(nodes);
    },

    _parseTextToNodes(rawText) {
        const rawLines = rawText.split('\n');
        const nodes = [];
        let tableRows = [];

        const flushTable = () => {
            if (tableRows.length > 0) {
                nodes.push({ type: 'table', rows: tableRows });
                tableRows = [];
            }
        };

        let currentLeftCol = '';
        let currentRightCol = [];

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i].trim();
            if (!line) continue;

            // Page break
            if (/^---\s*Página\s*\d+\s*---$/i.test(line)) {
                if (currentLeftCol || currentRightCol.length > 0) {
                    tableRows.push({ col1: currentLeftCol, col2: currentRightCol.join('\n') });
                    currentLeftCol = ''; currentRightCol = [];
                }
                flushTable();
                nodes.push({ type: 'pageBreak' });
                continue;
            }

            // Noise filter — only strip lone stray characters (scan margin
            // artifacts), not legit short words like "Sí", "No", "Dr", "N°".
            if (line.length <= 1 && !/^\d$/.test(line)) continue;

            // Section Heading
            if (this._isSectionHeading(line)) {
                if (currentLeftCol || currentRightCol.length > 0) {
                    tableRows.push({ col1: currentLeftCol, col2: currentRightCol.join('\n') });
                    currentLeftCol = ''; currentRightCol = [];
                }
                flushTable();
                nodes.push({ type: 'heading', text: line });
                continue;
            }

            // Detect Company / Role headers on left (e.g., "Sociedad Comercial...", "Empresa...", "Ingeniera...", "Ejecutiva...")
            const isCompanyLeft = /^(Sociedad|Empresa|Ingeniera|Ejecutiva|Director|Jefe|Analista|Consultor|Asistente|Administrador)\b/i.test(line) ||
                                  /\(\d{4}\s*-\s*\d{4}\)/.test(line);

            // Detect Duties on right (e.g., "Labores desempeñadas:", "- Atención...", "- Creación...")
            const isDutyRight = /^Labores desempeñadas:?/i.test(line) || /^[-•]\s*/.test(line);

            if (isCompanyLeft && !isDutyRight) {
                if (currentLeftCol && currentRightCol.length > 0) {
                    tableRows.push({ col1: currentLeftCol, col2: currentRightCol.join('\n') });
                    currentLeftCol = ''; currentRightCol = [];
                }
                currentLeftCol = currentLeftCol ? (currentLeftCol + '\n' + line) : line;
                continue;
            }

            if (isDutyRight) {
                currentRightCol.push(line);
                continue;
            }

            // Key-Value match (e.g. RUT: ...)
            const kvMatch = line.match(/^([A-ZÁÉÍÓÚÑa-záéíóúñ0-9\s,\.\/ºN°\-]{2,35}:)\s*(.+)$/);
            if (kvMatch) {
                if (currentLeftCol || currentRightCol.length > 0) {
                    tableRows.push({ col1: currentLeftCol, col2: currentRightCol.join('\n') });
                    currentLeftCol = ''; currentRightCol = [];
                }
                tableRows.push({ col1: kvMatch[1].trim(), col2: kvMatch[2].trim() });
                continue;
            }

            // If we are currently collecting duty lines for a left column
            if (currentLeftCol && (line.startsWith('-') || line.startsWith('•') || currentRightCol.length > 0)) {
                currentRightCol.push(line);
                continue;
            }

            if (currentLeftCol || currentRightCol.length > 0) {
                tableRows.push({ col1: currentLeftCol, col2: currentRightCol.join('\n') });
                currentLeftCol = ''; currentRightCol = [];
            }

            // Standard paragraph
            if (nodes.length < 3 && line.length < 50 && !line.includes(':')) {
                nodes.push({ type: 'title', text: line, isMain: (nodes.length === 0) });
            } else {
                nodes.push({ type: 'paragraph', text: line });
            }
        }

        if (currentLeftCol || currentRightCol.length > 0) {
            tableRows.push({ col1: currentLeftCol, col2: currentRightCol.join('\n') });
        }
        flushTable();
        return nodes;
    },

    _isSectionHeading(line) {
        const headings = [
            'antecedentes personales', 'antecedentes académicos', 'antecedentes laborales',
            'experiencia laboral', 'educación', 'formación académica', 'datos personales',
            'factura electronica', 'factura electrónica', 'boleta electronica',
            'datos del cliente', 'detalle de compra', 'resumen'
        ];
        const lower = line.toLowerCase().replace(/[^a-z0-9áéíóúñ\s]/g, '').trim();
        if (headings.includes(lower)) return true;

        if (line.length <= 40 && !line.includes(':') && !line.endsWith('.') && /^[A-ZÁÉÍÓÚÑ]/.test(line)) {
            const words = line.split(/\s+/);
            if (words.length <= 5 && words.every(w => w.length === 0 || /^[A-ZÁÉÍÓÚÑ]/.test(w) || w.length < 3)) {
                return true;
            }
        }
        return false;
    },

    // ---- Zip Generator for OpenXML ----
    async _generateOpenXmlZip(nodes) {
        const zip = new JSZip();

        // Images need a media file + relationship each; collect them while
        // rendering the body so the rest of the package can reference them.
        const mediaRels = [];
        let imgCounter = 0;

        const bodyXml = nodes.map(node => {
            if (node.type === 'image') {
                if (!node.bytes || !node.bytes.length) return '';
                imgCounter++;
                const relId = 'rIdImg' + imgCounter;
                const filename = 'image' + imgCounter + '.png';
                mediaRels.push({ relId, filename, bytes: node.bytes });
                return this._renderImageNodeXml(node, relId, imgCounter);
            }
            return this._renderNodeXml(node);
        }).join('\n');

        const title = App.fileName || 'Documento PDF';
        const now   = new Date().toISOString();

        // [Content_Types].xml
        const pngContentType = mediaRels.length
            ? '\n    <Default Extension="png" ContentType="image/png"/>' : '';
        zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>${pngContentType}
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

        // _rels/.rels
        zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
    <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

        // word/_rels/document.xml.rels
        const imageRelsXml = mediaRels.map(r =>
            `<Relationship Id="${r.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${r.filename}"/>`
        ).join('\n    ');
        zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
    ${imageRelsXml}
</Relationships>`);

        // word/media/*.png
        if (mediaRels.length) {
            const mediaFolder = zip.folder('word').folder('media');
            mediaRels.forEach(r => mediaFolder.file(r.filename, r.bytes));
        }

        // word/document.xml
        zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
            xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
            mc:Ignorable="w14"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
    <w:body>
        ${bodyXml}
        <w:sectPr>
            <w:pgSz w:w="12240" w:h="15840"/>
            <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"
                     w:header="720" w:footer="720" w:gutter="0"/>
        </w:sectPr>
    </w:body>
</w:document>`);

        // word/styles.xml
        zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:docDefaults>
        <w:rPrDefault>
            <w:rPr>
                <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
                <w:sz w:val="23"/>
                <w:szCs w:val="23"/>
                <w:lang w:val="es-ES" w:eastAsia="es-ES"/>
            </w:rPr>
        </w:rPrDefault>
    </w:docDefaults>
    <w:style w:type="paragraph" w:styleId="Normal">
        <w:name w:val="Normal"/>
        <w:pPr><w:spacing w:after="120" w:line="260" w:lineRule="auto"/></w:pPr>
    </w:style>
</w:styles>`);

        // docProps/core.xml
        zip.folder('docProps').file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <dc:title>${this._escapeXml(title)}</dc:title>
    <dc:creator>PDF Studio Pro</dc:creator>
    <dc:description>Documento formateado y exportado con PDF Studio Pro</dc:description>
    <cp:lastModifiedBy>PDF Studio Pro</cp:lastModifiedBy>
    <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
    <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
    <dc:language>es-ES</dc:language>
</cp:coreProperties>`);

        // docProps/app.xml
        zip.folder('docProps').file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
    <Application>PDF Studio Pro</Application>
</Properties>`);

        const blob = await zip.generateAsync({
            type: 'arraybuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        return new Uint8Array(blob);
    },

    // ---- Embedded Image Rendering ----
    _renderImageNodeXml(node, relId, docPrId) {
        let wPt = node.wPt > 0 ? node.wPt : 200;
        let hPt = node.hPt > 0 ? node.hPt : 150;
        const maxWPt = 400; // keep inside the page's content width
        if (wPt > maxWPt) {
            hPt = hPt * (maxWPt / wPt);
            wPt = maxWPt;
        }
        const cx = Math.max(1, Math.round(wPt * 12700));
        const cy = Math.max(1, Math.round(hPt * 12700));

        return `<w:p>
            <w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="160"/></w:pPr>
            <w:r>
                <w:drawing>
                    <wp:inline distT="0" distB="0" distL="0" distR="0">
                        <wp:extent cx="${cx}" cy="${cy}"/>
                        <wp:docPr id="${docPrId}" name="Imagen ${docPrId}"/>
                        <wp:cNvGraphicFramePr/>
                        <a:graphic>
                            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                                <pic:pic>
                                    <pic:nvPicPr>
                                        <pic:cNvPr id="${docPrId}" name="Imagen ${docPrId}"/>
                                        <pic:cNvPicPr/>
                                    </pic:nvPicPr>
                                    <pic:blipFill>
                                        <a:blip r:embed="${relId}"/>
                                        <a:stretch><a:fillRect/></a:stretch>
                                    </pic:blipFill>
                                    <pic:spPr>
                                        <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
                                        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                                    </pic:spPr>
                                </pic:pic>
                            </a:graphicData>
                        </a:graphic>
                    </wp:inline>
                </w:drawing>
            </w:r>
        </w:p>`;
    },

    _renderNodeXml(node) {
        if (node.type === 'pageBreak') {
            return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
        }

        if (node.type === 'imageCaption') {
            return `<w:p>
                <w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="40"/></w:pPr>
                <w:r>
                    <w:rPr><w:i/><w:sz w:val="18"/><w:szCs w:val="18"/><w:color w:val="6B7080"/></w:rPr>
                    <w:t xml:space="preserve">${this._escapeXml(node.text)}</w:t>
                </w:r>
            </w:p>`;
        }

        if (node.type === 'title') {
            const fontSize = node.isMain ? '32' : '24';
            const color = node.isMain ? '1A1D2B' : '4A5068';
            const spacing = node.isMain ? 'w:before="120" w:after="80"' : 'w:after="240"';
            return `<w:p>
                <w:pPr>
                    <w:jc w:val="center"/>
                    <w:spacing ${spacing}/>
                </w:pPr>
                <w:r>
                    <w:rPr>
                        ${node.isMain ? '<w:b/>' : ''}
                        <w:sz w:val="${fontSize}"/>
                        <w:szCs w:val="${fontSize}"/>
                        <w:color w:val="${color}"/>
                    </w:rPr>
                    <w:t xml:space="preserve">${this._escapeXml(node.text)}</w:t>
                </w:r>
            </w:p>`;
        }

        if (node.type === 'heading') {
            return `<w:p>
                <w:pPr>
                    <w:pBdr>
                        <w:bottom w:val="single" w:sz="6" w:space="4" w:color="6C63FF"/>
                    </w:pBdr>
                    <w:spacing w:before="240" w:after="120"/>
                </w:pPr>
                <w:r>
                    <w:rPr>
                        <w:b/>
                        <w:sz w:val="26"/>
                        <w:szCs w:val="26"/>
                        <w:color w:val="1A1D2B"/>
                    </w:rPr>
                    <w:t xml:space="preserve">${this._escapeXml(node.text)}</w:t>
                </w:r>
            </w:p>`;
        }

        if (node.type === 'table') {
            const rowsXml = node.rows.map(row => {
                const col1Paras = (row.col1 || '').split('\n').map(p =>
                    `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="2B2E3E"/></w:rPr><w:t xml:space="preserve">${this._escapeXml(p)}</w:t></w:r></w:p>`
                ).join('');

                const col2Paras = (row.col2 || '').split('\n').map(p =>
                    `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:color w:val="1A1D2B"/></w:rPr><w:t xml:space="preserve">${this._escapeXml(p)}</w:t></w:r></w:p>`
                ).join('');

                return `
                <w:tr>
                    <w:trPr><w:cantSplit/><w:spacing w:after="80"/></w:trPr>
                    <w:tc>
                        <w:tcPr>
                            <w:tcW w:w="3400" w:type="dxa"/>
                            <w:vAlign w:val="top"/>
                        </w:tcPr>
                        ${col1Paras || '<w:p/>'}
                    </w:tc>
                    <w:tc>
                        <w:tcPr>
                            <w:tcW w:w="5960" w:type="dxa"/>
                            <w:vAlign w:val="top"/>
                        </w:tcPr>
                        ${col2Paras || '<w:p/>'}
                    </w:tc>
                </w:tr>`;
            }).join('\n');

            return `<w:tbl>
                <w:tblPr>
                    <w:tblW w:w="9360" w:type="dxa"/>
                    <w:tblBorders>
                        <w:top w:val="none"/><w:left w:val="none"/>
                        <w:bottom w:val="none"/><w:right w:val="none"/>
                        <w:insideH w:val="none"/><w:insideV w:val="none"/>
                    </w:tblBorders>
                    <w:tblCellMar>
                        <w:top w:w="80" w:type="dxa"/>
                        <w:left w:w="80" w:type="dxa"/>
                        <w:bottom w:w="80" w:type="dxa"/>
                        <w:right w:w="80" w:type="dxa"/>
                    </w:tblCellMar>
                </w:tblPr>
                ${rowsXml}
            </w:tbl>
            <w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`;
        }

        return `<w:p>
            <w:pPr>
                <w:spacing w:after="100"/>
            </w:pPr>
            <w:r>
                <w:rPr>
                    <w:color w:val="222533"/>
                </w:rPr>
                <w:t xml:space="preserve">${this._escapeXml(node.text)}</w:t>
            </w:r>
        </w:p>`;
    },

    _escapeXml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
};
