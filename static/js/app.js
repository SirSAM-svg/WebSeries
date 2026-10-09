/**
 * RONGYOK SERIES - MAIN APPLICATION CONTROLLER
 * Manages 800+ Catalog, Pagination, Filters, Instant Search, View Routing, and Continue Watching.
 * Hybrid Architecture: Direct Static CDN Catalog + Cloudflare Edge API Fallback.
 */

class ShortFlixApp {
  constructor() {
    this.currentLang = 'all';
    this.currentGenre = 'ทั้งหมด';
    this.currentPage = 1;
    this.pageSize = 48;
    this.hasMore = false;
    this.masterCatalog = [];
    this.allDramas = [];
    this.activeDrama = null;
    this.searchTimer = null;
    this.isSearchMode = false;

    // Elements
    this.viewFeed = document.getElementById('view-feed');
    this.viewPlayer = document.getElementById('view-player');
    this.cardsGrid = document.getElementById('drama-cards-grid');
    this.gridCounter = document.getElementById('grid-counter');
    this.gridTitle = document.getElementById('grid-title');
    this.noResults = document.getElementById('no-results');
    this.wrapLoadMore = document.getElementById('wrap-load-more');
    this.btnLoadMore = document.getElementById('btn-load-more');

    // Hero
    this.heroBg = document.getElementById('hero-bg');
    this.heroTitle = document.getElementById('hero-title');
    this.heroSynopsis = document.getElementById('hero-synopsis');
    this.heroProvider = document.getElementById('hero-provider');
    this.heroRating = document.getElementById('hero-rating');
    this.heroEpisodes = document.getElementById('hero-episodes');
    this.btnHeroPlay = document.getElementById('btn-hero-play');
    this.btnHeroDetail = document.getElementById('btn-hero-detail');
    this.featuredDrama = null;

    // Search
    this.inputSearch = document.getElementById('input-search');
    this.btnClearSearch = document.getElementById('btn-clear-search');

    // Stats
    this.lblTotalCount = document.getElementById('lbl-total-count');

    // Sidebar player
    this.sideTitle = document.getElementById('side-drama-title');
    this.sideProvider = document.getElementById('side-drama-provider');
    this.sideRating = document.getElementById('side-drama-rating');
    this.sideTotal = document.getElementById('side-drama-total');
    this.sideSynopsis = document.getElementById('side-drama-synopsis');
    this.btnToggleSynopsis = document.getElementById('btn-toggle-synopsis');
    this.episodesGrid = document.getElementById('episodes-grid');
    this.epCountLbl = document.getElementById('ep-count-lbl');

    // Continue Watching
    this.sectionContinue = document.getElementById('section-continue');
    this.continueList = document.getElementById('continue-list');
    this.btnClearHistory = document.getElementById('btn-clear-history');

    // Navigation
    this.btnBackToBrowse = document.getElementById('btn-back-to-browse');
    this.btnLogo = document.getElementById('btn-logo');

    // Mobile Drawer
    this.mobileDrawer = document.getElementById('mobile-ep-drawer');
    this.drawerBackdrop = document.getElementById('drawer-backdrop');
    this.btnCloseDrawer = document.getElementById('btn-close-drawer');
    this.btnOpenDrawer = document.getElementById('btn-open-ep-drawer');
    this.drawerGrid = document.getElementById('drawer-episodes-grid');
    this.drawerEpCount = document.getElementById('drawer-ep-count');

    // Toast
    this.toast = document.getElementById('toast');
    this.toastMessage = document.getElementById('toast-message');

    this.player = new VerticalPlayer();
    this.init();
  }

  async init() {
    this.detectAndApplyMobileMode();
    window.addEventListener('resize', () => this.detectAndApplyMobileMode());
    this.bindEvents();
    await this.loadCatalogAndRender();
    this.renderContinueWatching();
  }

  detectAndApplyMobileMode() {
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const isNarrow = window.innerWidth <= 768;
    const isMobile = isMobileUA || (isTouch && isNarrow);
    document.body.classList.toggle('is-mobile-device', isMobile);
    return isMobile;
  }

  bindEvents() {
    // Navigation / Routing
    this.btnLogo.addEventListener('click', (e) => {
      e.preventDefault();
      this.showFeedView();
    });

    this.btnBackToBrowse.addEventListener('click', () => {
      this.showFeedView();
    });

    // Hero buttons
    this.btnHeroPlay.addEventListener('click', () => {
      if (this.featuredDrama) {
        this.openDrama(this.featuredDrama, 1);
      }
    });

    this.btnHeroDetail.addEventListener('click', () => {
      if (this.featuredDrama) {
        this.openDrama(this.featuredDrama, 1);
      }
    });

    // Language pills filter
    document.querySelectorAll('#lang-pills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#lang-pills .pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentLang = btn.dataset.lang;
        this.currentPage = 1;
        this.isSearchMode = false;
        this.applyFiltersAndRender(1, false);
      });
    });

    // Genre pills filter
    document.querySelectorAll('#genre-pills .pill-genre').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#genre-pills .pill-genre').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentGenre = btn.dataset.genre;
        this.currentPage = 1;
        this.isSearchMode = false;
        this.applyFiltersAndRender(1, false);
      });
    });

    // Load More Button
    if (this.btnLoadMore) {
      this.btnLoadMore.addEventListener('click', () => {
        if (this.hasMore) {
          this.applyFiltersAndRender(this.currentPage + 1, true);
        }
      });
    }

    // Search input with instant responsive debounce
    this.inputSearch.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      this.btnClearSearch.classList.toggle('hidden', !q);
      
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.performSearch(q);
      }, 250);
    });

    this.btnClearSearch.addEventListener('click', () => {
      this.inputSearch.value = '';
      this.btnClearSearch.classList.add('hidden');
      this.isSearchMode = false;
      this.applyFiltersAndRender(1, false);
    });

    // Reset filter button
    document.getElementById('btn-reset-filter').addEventListener('click', () => {
      this.inputSearch.value = '';
      this.btnClearSearch.classList.add('hidden');
      this.currentLang = 'all';
      this.currentGenre = 'ทั้งหมด';
      this.isSearchMode = false;
      document.querySelectorAll('#lang-pills .pill').forEach(b => b.classList.toggle('active', b.dataset.lang === 'all'));
      document.querySelectorAll('#genre-pills .pill-genre').forEach(b => b.classList.toggle('active', b.dataset.genre === 'ทั้งหมด'));
      this.applyFiltersAndRender(1, false);
    });

    // Clear continue watching history
    this.btnClearHistory.addEventListener('click', () => {
      if (confirm('คุณต้องการล้างประวัติการรับชมหรือไม่?')) {
        localStorage.removeItem('shortflix_history');
        this.renderContinueWatching();
        this.showToast('ล้างประวัติการดูแล้ว');
      }
    });

    // Toggle synopsis expand
    this.btnToggleSynopsis.addEventListener('click', () => {
      const isCollapsed = this.sideSynopsis.classList.contains('collapsed');
      this.sideSynopsis.classList.toggle('collapsed');
      this.btnToggleSynopsis.textContent = isCollapsed ? 'ย่อเรื่องย่อ' : 'อ่านเพิ่มเติม';
    });

    // Mobile Episode Drawer Events
    if (this.btnOpenDrawer) {
      this.btnOpenDrawer.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEpisodeDrawer();
      });
    }
    if (this.btnCloseDrawer) {
      this.btnCloseDrawer.addEventListener('click', () => this.closeEpisodeDrawer());
    }
    if (this.drawerBackdrop) {
      this.drawerBackdrop.addEventListener('click', () => this.closeEpisodeDrawer());
    }

    // Keyboard shortcut '/' to search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== this.inputSearch) {
        e.preventDefault();
        this.inputSearch.focus();
      }
    });
  }

  showFeedView() {
    this.viewPlayer.classList.remove('active');
    this.viewFeed.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.renderContinueWatching();
  }

  showPlayerView() {
    this.viewFeed.classList.remove('active');
    this.viewPlayer.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Loads catalog with dual redundancy:
   * 1. Direct fetch from static /data/seed_data.json (blazing fast, 100% reliable on Cloudflare)
   * 2. Edge API fallback /api/feed
   */
  async loadCatalogAndRender() {
    // Strategy 1: Direct static asset fetch
    try {
      const res = await fetch('/data/seed_data.json');
      if (res.ok) {
        const seed = await res.json();
        if (seed && seed.dramas && seed.dramas.length > 0) {
          this.masterCatalog = seed.dramas;
          this.featuredDrama = seed.featured || seed.dramas[0];
          this.renderHero(this.featuredDrama);
          this.applyFiltersAndRender(1, false);
          return;
        }
      }
    } catch (e) {
      console.warn('Direct static seed fetch failed, falling back to edge API:', e);
    }

    // Strategy 2: Edge API /api/feed
    await this.loadFeed(1, false);
  }

  async loadFeed(page = 1, append = false) {
    try {
      this.currentPage = page;
      const res = await fetch(`/api/feed?lang=${this.currentLang}&genre=${encodeURIComponent(this.currentGenre)}&page=${page}&limit=${this.pageSize}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const data = await res.json();
      if (data.status) {
        if (!append) {
          this.allDramas = data.dramas || [];
          this.featuredDrama = data.featured || (this.allDramas[0] || null);
          this.renderHero(this.featuredDrama);
        } else {
          this.allDramas = [...this.allDramas, ...(data.dramas || [])];
        }

        this.hasMore = data.has_more;
        if (this.lblTotalCount) {
          this.lblTotalCount.textContent = data.total;
        }

        this.renderDramaGrid(this.allDramas, append);
        this.wrapLoadMore.classList.toggle('hidden', !this.hasMore);
        this.gridCounter.textContent = `${this.allDramas.length} / ${data.total} เรื่อง`;
      }
    } catch (e) {
      console.error('Failed to load feed via API:', e);
      if (this.cardsGrid.children.length === 0) {
        this.noResults.classList.remove('hidden');
      }
    }
  }

  applyFiltersAndRender(page = 1, append = false) {
    if (!this.masterCatalog || this.masterCatalog.length === 0) {
      this.loadFeed(page, append);
      return;
    }

    this.currentPage = page;
    let filtered = this.masterCatalog;

    // Filter audio / language
    if (this.currentLang === 'dubbed') {
      filtered = filtered.filter(d => 
        (d.language && d.language.includes('พากย์ไทย')) || 
        (d.genre && d.genre.includes('พากย์ไทย'))
      );
    } else if (this.currentLang === 'subbed') {
      filtered = filtered.filter(d => 
        (d.language && d.language.includes('ซับไทย')) || 
        (d.genre && d.genre.includes('ซับไทย'))
      );
    }

    // Filter genre
    if (this.currentGenre && this.currentGenre !== 'ทั้งหมด') {
      const gLower = this.currentGenre.toLowerCase();
      filtered = filtered.filter(d => 
        d.genre && d.genre.some(g => g.toLowerCase().includes(gLower))
      );
    }

    const totalCount = filtered.length;
    const endIdx = page * this.pageSize;
    const paginatedDramas = filtered.slice(0, endIdx);

    this.allDramas = paginatedDramas;
    this.hasMore = endIdx < totalCount;

    if (this.lblTotalCount) {
      this.lblTotalCount.textContent = totalCount;
    }

    if (!append && paginatedDramas.length > 0 && !this.featuredDrama) {
      this.featuredDrama = paginatedDramas[0];
      this.renderHero(this.featuredDrama);
    }

    this.renderDramaGrid(paginatedDramas, false);
    this.wrapLoadMore.classList.toggle('hidden', !this.hasMore);
    this.gridCounter.textContent = `${paginatedDramas.length} / ${totalCount} เรื่อง`;
  }

  renderHero(drama) {
    if (!drama) return;
    this.heroBg.style.backgroundImage = `url(${drama.banner || drama.cover})`;
    this.heroTitle.textContent = drama.title;
    this.heroSynopsis.textContent = drama.synopsis;
    this.heroProvider.textContent = 'RONGYOK';
    this.heroRating.textContent = drama.rating || '9.8';
    this.heroEpisodes.textContent = `${drama.episodes || 60} ตอน (จบแล้ว)`;
  }

  renderDramaGrid(dramas, append = false) {
    if (!append) {
      this.cardsGrid.innerHTML = '';
    }

    if (dramas.length === 0) {
      this.noResults.classList.remove('hidden');
      this.wrapLoadMore.classList.add('hidden');
      return;
    }
    this.noResults.classList.add('hidden');

    const sliceToRender = append ? dramas.slice(-this.pageSize) : dramas;

    sliceToRender.forEach(drama => {
      const card = document.createElement('div');
      card.className = 'drama-card';
      
      const primaryGenre = (drama.genre && drama.genre.length) ? drama.genre[0] : 'หนังสั้นจีน';
      const isSub = (drama.language && drama.language.includes('ซับ')) || (drama.genre && drama.genre.includes('ซับไทย'));
      const badgeColor = isSub ? 'background: rgba(16, 185, 129, 0.9);' : 'background: rgba(37, 99, 235, 0.9);';
      const badgeText = isSub ? 'ซับไทย' : 'พากย์ไทย';
      const sid = drama.series_id || (drama.id ? drama.id.replace('ry-', '') : '100309804');

      card.innerHTML = `
        <div class="card-poster-wrap">
          <img class="card-poster" src="${drama.cover}" alt="${drama.title}" loading="lazy" referrerpolicy="no-referrer" data-sid="${sid}" onerror="this.onerror=null; this.src='https://rongyok.com/images/poster/${sid}.webp';">
          <span class="card-badge-top" style="${badgeColor}">${badgeText}</span>
          <span class="card-badge-right">★ ${drama.rating || '9.5'}</span>
          <span class="card-ep-counter">${drama.episodes || 60} ตอน</span>
        </div>
        <div class="card-content">
          <h3 class="card-title" title="${drama.title}">${drama.title}</h3>
          <span class="card-genre">${primaryGenre}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        const lastEp = this.getLastWatchedEpisode(drama.id) || 1;
        this.openDrama(drama, lastEp);
      });

      this.cardsGrid.appendChild(card);
    });
  }

  performSearch(keyword) {
    if (!keyword) {
      this.isSearchMode = false;
      this.applyFiltersAndRender(1, false);
      return;
    }

    this.isSearchMode = true;
    const qLower = keyword.toLowerCase();

    // Instant Client-side Search over the 827 series
    if (this.masterCatalog && this.masterCatalog.length > 0) {
      const results = this.masterCatalog.filter(d => 
        (d.title && d.title.toLowerCase().includes(qLower)) ||
        (d.synopsis && d.synopsis.toLowerCase().includes(qLower)) ||
        (d.genre && d.genre.some(g => g.toLowerCase().includes(gLower)))
      );
      this.renderDramaGrid(results, false);
      this.gridCounter.textContent = `${results.length} เรื่อง`;
      this.wrapLoadMore.classList.add('hidden');
      return;
    }

    // Fallback Edge Search API
    fetch(`/api/search?q=${encodeURIComponent(keyword)}`)
      .then(res => res.json())
      .then(data => {
        if (data.status && data.results) {
          this.renderDramaGrid(data.results, false);
          this.gridCounter.textContent = `${data.results.length} เรื่อง`;
          this.wrapLoadMore.classList.add('hidden');
        }
      })
      .catch(e => console.warn('Search request error:', e));
  }

  async openDrama(drama, epNum = 1) {
    this.activeDrama = drama;
    this.showPlayerView();

    // Fill Sidebar Details
    this.sideTitle.textContent = drama.title;
    this.sideProvider.textContent = 'RONGYOK';
    this.sideRating.textContent = drama.rating || '9.8';
    this.sideSynopsis.textContent = drama.synopsis || 'ไม่มีเรื่องย่อ';

    // Build Episode grid dynamically from server
    await this.loadEpisodeButtons(drama, epNum);

    // Tell player to load video stream
    this.player.loadEpisode(drama, epNum);
  }

  async loadEpisodeButtons(drama, activeEp = 1) {
    this.episodesGrid.innerHTML = '<div style="color: #9ca3af; padding: 10px;">กำลังโหลดรายชื่อตอน...</div>';
    if (this.drawerGrid) {
      this.drawerGrid.innerHTML = '<div style="color: #9ca3af; padding: 10px; grid-column: span 5; text-align: center;">กำลังโหลดรายชื่อตอน...</div>';
    }

    let total = drama.episodes || 60;
    
    try {
      const res = await fetch(`/api/episodes/${drama.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status && data.episodes && data.episodes.length > 0) {
          total = data.episodes.length;
        }
      }
    } catch (e) {
      console.warn('Using fallback episode count:', e);
    }

    this.sideTotal.textContent = `${total} ตอน`;
    this.epCountLbl.textContent = total;
    if (this.drawerEpCount) this.drawerEpCount.textContent = total;

    this.episodesGrid.innerHTML = '';
    if (this.drawerGrid) this.drawerGrid.innerHTML = '';

    const watchedList = JSON.parse(localStorage.getItem(`shortflix_watched_${drama.id}`) || '[]');

    for (let ep = 1; ep <= total; ep++) {
      // Desktop sidebar button
      const btn = document.createElement('button');
      btn.className = `ep-btn ${ep === activeEp ? 'active' : ''} ${watchedList.includes(ep) ? 'watched' : ''}`;
      btn.dataset.ep = ep;
      btn.textContent = `Ep.${ep}`;
      btn.addEventListener('click', () => {
        this.player.loadEpisode(drama, ep);
      });
      this.episodesGrid.appendChild(btn);

      // Mobile drawer button
      if (this.drawerGrid) {
        const mBtn = document.createElement('button');
        mBtn.className = `ep-btn ${ep === activeEp ? 'active' : ''} ${watchedList.includes(ep) ? 'watched' : ''}`;
        mBtn.dataset.ep = ep;
        mBtn.textContent = `Ep.${ep}`;
        mBtn.addEventListener('click', () => {
          this.player.loadEpisode(drama, ep);
          this.closeEpisodeDrawer();
        });
        this.drawerGrid.appendChild(mBtn);
      }
    }
  }

  openEpisodeDrawer() {
    if (this.mobileDrawer) {
      this.mobileDrawer.classList.remove('hidden');
    }
  }

  closeEpisodeDrawer() {
    if (this.mobileDrawer) {
      this.mobileDrawer.classList.add('hidden');
    }
  }

  updateSidebarActiveEpisode(currentEp) {
    document.querySelectorAll('.ep-btn').forEach(btn => {
      const ep = parseInt(btn.dataset.ep, 10);
      btn.classList.toggle('active', ep === currentEp);
    });
  }

  refreshWatchedButtons(dramaId) {
    const watchedList = JSON.parse(localStorage.getItem(`shortflix_watched_${dramaId}`) || '[]');
    document.querySelectorAll('.ep-btn').forEach(btn => {
      const ep = parseInt(btn.dataset.ep, 10);
      if (watchedList.includes(ep)) {
        btn.classList.add('watched');
      }
    });
  }

  saveContinueWatching(drama, epNum) {
    try {
      let history = JSON.parse(localStorage.getItem('shortflix_history') || '[]');
      history = history.filter(h => h.id !== drama.id);
      history.unshift({
        id: drama.id,
        title: drama.title,
        cover: drama.cover,
        provider: 'rongyok',
        episodes: drama.episodes,
        lastEp: epNum,
        timestamp: Date.now()
      });
      history = history.slice(0, 15);
      localStorage.setItem('shortflix_history', JSON.stringify(history));
    } catch (e) {}
  }

  getLastWatchedEpisode(dramaId) {
    try {
      const history = JSON.parse(localStorage.getItem('shortflix_history') || '[]');
      const found = history.find(h => h.id === dramaId);
      return found ? found.lastEp : null;
    } catch (e) {
      return null;
    }
  }

  renderContinueWatching() {
    try {
      const history = JSON.parse(localStorage.getItem('shortflix_history') || '[]');
      if (!history.length) {
        this.sectionContinue.classList.add('hidden');
        return;
      }

      this.sectionContinue.classList.remove('hidden');
      this.continueList.innerHTML = '';

      history.forEach(item => {
        const card = document.createElement('div');
        card.className = 'continue-card';
        card.innerHTML = `
          <img class="continue-thumb" src="${item.cover}" alt="${item.title}" referrerpolicy="no-referrer">
          <div class="continue-info">
            <div class="continue-title" title="${item.title}">${item.title}</div>
            <div class="continue-ep">ดูต่อ ตอนที่ ${item.lastEp}</div>
          </div>
        `;
        card.addEventListener('click', () => {
          this.openDrama(item, item.lastEp);
        });
        this.continueList.appendChild(card);
      });
    } catch (e) {}
  }

  showToast(message) {
    this.toastMessage.textContent = message;
    this.toast.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.add('hidden');
    }, 2800);
  }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  window.app = new ShortFlixApp();
});
