/* ============================================================
   ui.js — User Interface Utilities
   PDF Studio Pro
   ============================================================ */

const UI = {
    _leftOpen:  true,
    _rightOpen: true,
    _activeTab: 'ocr',

    // ---- Sidebar Toggles ----
    toggleLeftSidebar() {
        const sidebar = document.getElementById('sidebarLeft');
        this._leftOpen = !this._leftOpen;
        sidebar.classList.toggle('collapsed', !this._leftOpen);

        // On mobile, use class instead of width
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle('mobile-open', this._leftOpen);
        }
    },

    toggleRightPanel() {
        const panel = document.getElementById('panelRight');
        this._rightOpen = !this._rightOpen;
        panel.classList.toggle('collapsed', !this._rightOpen);
        document.getElementById('panelToggleBtn').style.color =
            this._rightOpen ? '' : 'var(--primary)';
    },

    // ---- Tab Switching ----
    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.vtab').forEach(btn => {
            btn.classList.toggle('active', btn.id === 'vtab-' + tabName);
        });

        // Update panels
        document.querySelectorAll('.tool-panel').forEach(panel => {
            const isActive = panel.id === 'panel-' + tabName;
            panel.style.display = isActive ? 'flex' : 'none';
            if (isActive) {
                // trigger animation
                panel.classList.remove('active');
                void panel.offsetWidth; // reflow
                panel.classList.add('active');
            }
        });

        this._activeTab = tabName;

        // Re-initialize signature canvas if switching to sign tab
        if (tabName === 'sign') {
            setTimeout(() => Signature.resize(), 50);
        }

        // Ensure right panel is open
        if (!this._rightOpen) this.toggleRightPanel();
    },

    // ---- Dropdowns ----
    toggleDropdown(id) {
        const menu = document.getElementById(id);
        if (!menu) return;
        const isOpen = menu.classList.contains('open');
        this.closeDropdowns();
        if (!isOpen) menu.classList.add('open');
    },

    closeDropdowns() {
        document.querySelectorAll('.dropdown-menu.open').forEach(m => m.classList.remove('open'));
    },

    // ---- Status Bar ----
    setStatus(text, type = 'ok') {
        document.getElementById('statusText').textContent = text;
        const dot = document.getElementById('statusDot');
        dot.className = 'status-dot';
        if (type === 'busy')  dot.classList.add('busy');
        if (type === 'error') dot.classList.add('error');
    },

    setPageStatus(current, total) {
        document.getElementById('statusCenter').textContent =
            total > 0 ? `Página ${current} de ${total}` : '';
        document.getElementById('pageInput').value = current;
        document.getElementById('totalPages').textContent = total;

        document.getElementById('btnPrev').disabled = current <= 1;
        document.getElementById('btnNext').disabled = current >= total;
    },

    // ---- Toast Notifications ----
    toast(message, type = 'info', duration = 3500) {
        const icons = {
            success: 'check_circle',
            error:   'error',
            warning: 'warning',
            info:    'info'
        };
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="material-icons-round">${icons[type] || 'info'}</span>
            <span class="toast-msg">${message}</span>
        `;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('removing');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
};

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown-wrapper')) {
        UI.closeDropdowns();
    }
});
