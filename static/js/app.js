/**
 * SO+ SERIES & 4K MOVIES - MAIN APPLICATION CONTROLLER
 * Manages Unified Catalog (GoSeries4K + Torbo007 4K Series & RongYok 850+ Short Dramas),
 * Provider Filtering, Dual-Audio Track Switching, Favorites, Comments, Search, and Watch History.
 */

class ShortFlixApp {
  constructor() {
    this.currentProvider = 'all';
    this.currentLang = 'all';
    this.currentGenre = 'ทั้งหมด';
    this.currentPage = 1;
    this.pageSize = 48;
    this.hasMore = false;
    this.masterCatalog = [];
    this.allDramas = [];
    this.activeDrama = null;
    this.activeEpisodeList = [];
    this.episodesByLang = {};
    this.activeLangTrack = '';
    this.searchTimer = null;
    this.isSearchMode = false;
    this.favoritesSet = new Set();

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
    this.heroBanner = document.getElementById('hero-banner');
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
    this.activeSearchQuery = '';

    // Stats & Favorites count
    this.lblTotalCount = document.getElementById('lbl-total-count');
    this.favCountPill = document.getElementById('fav-count-pill');

    // Sidebar player
    this.sideTitle = document.getElementById('side-drama-title');
    this.sideProvider = document.getElementById('side-drama-provider');
    this.sideRating = document.getElementById('side-drama-rating');
    this.sideTotal = document.getElementById('side-drama-total');
    this.sideSynopsis = document.getElementById('side-drama-synopsis');
    this.btnToggleSynopsis = document.getElementById('btn-toggle-synopsis');
    this.episodesGrid = document.getElementById('episodes-grid');
    this.epCountLbl = document.getElementById('ep-count-lbl');
    this.btnFavDrama = document.getElementById('btn-fav-drama');
    this.favDramaIcon = document.getElementById('fav-drama-icon');
    this.favDramaText = document.getElementById('fav-drama-text');

    // Dual-Audio Track Switcher & Comments (Sidebar + Video Overlay + Mobile Drawer)
    this.audioTrackSection = document.getElementById('audio-track-section');
    this.audioTrackButtons = document.getElementById('audio-track-buttons');
    this.overlayAudioButtons = document.getElementById('overlay-audio-buttons');
    this.drawerAudioSection = document.getElementById('drawer-audio-track-section');
    this.drawerAudioButtons = document.getElementById('drawer-audio-track-buttons');
    this.commentsSection = document.getElementById('goseries-comments-section');
    this.commentsList = document.getElementById('goseries-comments-list');
    this.commentsCountLbl = document.getElementById('comments-count-lbl');

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
    await this.loadFavorites();
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

  async loadFavorites() {
    try {
      const localFavs = JSON.parse(localStorage.getItem('shortflix_favorites') || '[]');
      localFavs.forEach(id => this.favoritesSet.add(id));
    } catch (e) {}

    try {
      const res = await fetch('/api/favorites');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.favorites)) {
          data.favorites.forEach(r => {
            if (r.drama_id) this.favoritesSet.add(r.drama_id);
          });
          localStorage.setItem('shortflix_favorites', JSON.stringify(Array.from(this.favoritesSet)));
        }
      }
    } catch (e) {}
    this.updateFavoritesCounter();
  }

  updateFavoritesCounter() {
    if (this.favCountPill) {
      this.favCountPill.textContent = this.favoritesSet.size;
    }
  }

  async toggleFavorite(dramaId, dramaTitle = '') {
    if (!dramaId) return false;
    const isFav = this.favoritesSet.has(dramaId);
    if (isFav) {
      this.favoritesSet.delete(dramaId);
    } else {
      this.favoritesSet.add(dramaId);
    }
    localStorage.setItem('shortflix_favorites', JSON.stringify(Array.from(this.favoritesSet)));
    this.updateFavoritesCounter();

    fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drama_id: dramaId, action: isFav ? 'remove' : 'add' }),
    }).catch(() => {});

    // Update UI buttons
    document.querySelectorAll(`.card-fav-btn[data-fav-id="${dramaId}"]`).forEach(btn => {
      btn.classList.toggle('favorited', !isFav);
      btn.textContent = !isFav ? '❤️' : '🤍';
    });

    if (this.activeDrama && this.activeDrama.id === dramaId) {
      this.updateSidebarFavButton();
    }

    if (this.currentProvider === 'favorites') {
      this.applyFiltersAndRender(1, false);
    }

    this.showToast(!isFav ? `เพิ่ม "${dramaTitle || dramaId}" ในรายการโปรด ❤️` : 'นำออกจากรายการโปรดแล้ว');
    return !isFav;
  }

  updateSidebarFavButton() {
    if (!this.btnFavDrama || !this.activeDrama) return;
    const isFav = this.favoritesSet.has(this.activeDrama.id);
    this.btnFavDrama.classList.toggle('favorited', isFav);
    if (this.favDramaIcon) this.favDramaIcon.textContent = isFav ? '❤️' : '🤍';
    if (this.favDramaText) this.favDramaText.textContent = isFav ? 'ในรายการโปรดแล้ว' : 'รายการโปรด';
  }

  bindEvents() {
    // Navigation / Routing
    this.btnLogo.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.isSearchMode) {
        this.clearSearch();
      }
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

    // Sidebar Favorite button
    if (this.btnFavDrama) {
      this.btnFavDrama.addEventListener('click', () => {
        if (this.activeDrama) {
          this.toggleFavorite(this.activeDrama.id, this.activeDrama.title);
        }
      });
    }

    // Provider pills filter (All / GoSeries4K / RongYok / Favorites)
    document.querySelectorAll('#provider-pills .pill-provider').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#provider-pills .pill-provider').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentProvider = btn.dataset.provider || 'all';
        this.currentPage = 1;
        if (this.isSearchMode && this.activeSearchQuery) {
          this.performSearch(this.activeSearchQuery, false);
        } else {
          this.exitSearchMode(false);
          this.applyFiltersAndRender(1, false);
        }
      });
    });

    // Language pills filter
    document.querySelectorAll('#lang-pills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#lang-pills .pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentLang = btn.dataset.lang;
        this.currentPage = 1;
        if (this.isSearchMode && this.activeSearchQuery) {
          this.performSearch(this.activeSearchQuery, false);
        } else {
          this.exitSearchMode(false);
          this.applyFiltersAndRender(1, false);
        }
      });
    });

    // Genre pills filter
    document.querySelectorAll('#genre-pills .pill-genre').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#genre-pills .pill-genre').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentGenre = btn.dataset.genre;
        this.currentPage = 1;
        if (this.isSearchMode && this.activeSearchQuery) {
          this.performSearch(this.activeSearchQuery, false);
        } else {
          this.exitSearchMode(false);
          this.applyFiltersAndRender(1, false);
        }
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

    // Search input with instant responsive debounce + Enter/Escape support
    const handleSearchInput = () => {
      const q = this.inputSearch.value.trim();
      this.btnClearSearch.classList.toggle('hidden', !q);

      clearTimeout(this.searchTimer);
      if (!q) {
        this.performSearch('', false);
        return;
      }
      this.searchTimer = setTimeout(() => {
        this.performSearch(q, false);
      }, 150);
    };

    this.inputSearch.addEventListener('input', handleSearchInput);
    this.inputSearch.addEventListener('search', handleSearchInput);

    this.inputSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(this.searchTimer);
        const q = this.inputSearch.value.trim();
        this.btnClearSearch.classList.toggle('hidden', !q);
        this.performSearch(q, true);
        if (window.innerWidth <= 768) {
          this.inputSearch.blur();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.clearSearch();
        this.inputSearch.blur();
      }
    });

    this.btnClearSearch.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.clearSearch();
      this.inputSearch.focus();
    });

    // Reset filter button
    document.getElementById('btn-reset-filter').addEventListener('click', () => {
      this.inputSearch.value = '';
      this.btnClearSearch.classList.add('hidden');
      this.currentProvider = 'all';
      this.currentLang = 'all';
      this.currentGenre = 'ทั้งหมด';
      document.querySelectorAll('#provider-pills .pill-provider').forEach(b => b.classList.toggle('active', b.dataset.provider === 'all'));
      document.querySelectorAll('#lang-pills .pill').forEach(b => b.classList.toggle('active', b.dataset.lang === 'all'));
      document.querySelectorAll('#genre-pills .pill-genre').forEach(b => b.classList.toggle('active', b.dataset.genre === 'ทั้งหมด'));
      this.exitSearchMode(true);
    });

    // Clear continue watching history
    this.btnClearHistory.addEventListener('click', () => {
      if (confirm('คุณต้องการล้างประวัติการรับชมหรือไม่?')) {
        localStorage.removeItem('shortflix_history');
        fetch('/api/history', { method: 'DELETE' }).catch(() => {});
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
      if (e.key === '/' && document.activeElement !== this.inputSearch && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        this.inputSearch.focus();
        this.inputSearch.select();
      }
    });
  }

  clearSearch() {
    clearTimeout(this.searchTimer);
    this.inputSearch.value = '';
    this.btnClearSearch.classList.add('hidden');
    this.exitSearchMode(true);
  }

  exitSearchMode(render = true) {
    this.isSearchMode = false;
    this.activeSearchQuery = '';
    if (this.heroBanner) {
      this.heroBanner.classList.remove('hidden');
    }
    this.renderContinueWatching();
    if (render) {
      this.applyFiltersAndRender(1, false);
    }
  }

  showFeedView() {
    document.body.classList.remove('in-player-mode');
    this.viewPlayer.classList.remove('active');
    this.viewFeed.classList.add('active');
    if (this.player && this.player.video) {
      this.player.video.pause();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.renderContinueWatching();
  }

  showPlayerView() {
    document.body.classList.add('in-player-mode');
    this.viewFeed.classList.remove('active');
    this.viewPlayer.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async loadCatalogAndRender() {
    // Strategy 1: Direct static asset fetch (/data/seed_data.json)
    try {
      const res = await fetch('/data/seed_data.json?t=' + Date.now());
      if (res.ok) {
        const seed = await res.json();
        if (seed && seed.dramas && seed.dramas.length > 0) {
          this.masterCatalog = seed.dramas;
          this.featuredDrama = seed.dramas[0];
          this.renderHero(this.featuredDrama);
          this.updateProviderCounts();
          if (this.isSearchMode && this.activeSearchQuery) {
            this.performSearch(this.activeSearchQuery, false);
          } else {
            this.applyFiltersAndRender(1, false);
          }
          return;
        }
      }
    } catch (e) {
      console.warn('Direct static seed fetch failed, falling back to API:', e);
    }

    // Strategy 2: Fetch full catalog from /api/feed
    try {
      const res = await fetch('/api/feed?lang=all&genre=' + encodeURIComponent('ทั้งหมด') + '&page=1&limit=1200');
      if (res.ok) {
        const data = await res.json();
        if (data && data.status && Array.isArray(data.dramas) && data.dramas.length > 0) {
          this.masterCatalog = data.dramas;
          this.featuredDrama = data.featured || data.dramas[0];
          this.renderHero(this.featuredDrama);
          this.updateProviderCounts();
          if (this.isSearchMode && this.activeSearchQuery) {
            this.performSearch(this.activeSearchQuery, false);
          } else {
            this.applyFiltersAndRender(1, false);
          }
          return;
        }
      }
    } catch (e) {
      console.warn('Full catalog API fallback failed:', e);
    }
  }

  updateProviderCounts() {
    if (!this.masterCatalog || !this.masterCatalog.length) return;
    const total = this.masterCatalog.length;
    const gsCount = this.masterCatalog.filter(d => d.provider === 'goseries4k').length;
    const ryCount = total - gsCount;

    const pillAll = document.getElementById('pill-prov-all');
    const pillGs = document.getElementById('pill-prov-goseries');
    const pillRy = document.getElementById('pill-prov-rongyok');
    if (pillAll) pillAll.textContent = `🔥 ทั้งหมด (${total})`;
    if (pillGs) pillGs.textContent = `🎬 ซีรีส์ & หนัง 4K (${gsCount})`;
    if (pillRy) pillRy.textContent = `📱 หนังสั้นจีน (${ryCount})`;
  }

  applyFiltersAndRender(page = 1, append = false) {
    if (!this.masterCatalog || this.masterCatalog.length === 0) return;

    this.currentPage = page;
    let filtered = this.masterCatalog;

    // 1. Filter by provider / favorites
    if (this.currentProvider === 'goseries4k') {
      filtered = filtered.filter(d => d.provider === 'goseries4k');
      if (this.gridTitle) this.gridTitle.textContent = '🎬 ซีรีส์และหนัง 4K HD (GoSeries4K + Torbo007)';
    } else if (this.currentProvider === 'rongyok') {
      filtered = filtered.filter(d => d.provider !== 'goseries4k');
      if (this.gridTitle) this.gridTitle.textContent = '📱 หนังสั้นจีนแนวตั้ง (RongYok Short Series)';
    } else if (this.currentProvider === 'favorites') {
      filtered = filtered.filter(d => this.favoritesSet.has(d.id));
      if (this.gridTitle) this.gridTitle.textContent = '❤️ รายการโปรดของคุณ (Favorites)';
    } else {
      if (this.gridTitle) this.gridTitle.textContent = 'ซีรีส์และหนังทั้งหมดในระบบ (All Catalog)';
    }

    // 2. Filter audio / language
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

    // 3. Filter genre
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
      this.lblTotalCount.textContent = this.masterCatalog.length || totalCount;
    }

    if (!append && paginatedDramas.length > 0) {
      this.featuredDrama = paginatedDramas[0];
      this.renderHero(this.featuredDrama);
    }

    this.renderDramaGrid(paginatedDramas, false);
    this.wrapLoadMore.classList.toggle('hidden', !this.hasMore);
    this.gridCounter.textContent = `${paginatedDramas.length} / ${totalCount} เรื่อง`;
  }

  renderHero(drama) {
    if (!drama) return;
    const bgUrl = drama.banner || drama.cover || drama.remote_cover || '';
    this.heroBg.style.backgroundImage = `url("${bgUrl}")`;
    this.heroTitle.textContent = drama.title;
    this.heroSynopsis.textContent = drama.synopsis;
    const isGoSeries = drama.provider === 'goseries4k';
    this.heroProvider.textContent = isGoSeries ? 'GOSERIES 4K' : 'RONGYOK';
    this.heroProvider.style.background = isGoSeries ? 'rgba(249, 115, 22, 0.25)' : 'rgba(16, 185, 129, 0.25)';
    this.heroProvider.style.color = isGoSeries ? '#fb923c' : '#34d399';
    this.heroProvider.style.borderColor = isGoSeries ? 'rgba(249, 115, 22, 0.45)' : 'rgba(16, 185, 129, 0.4)';
    if (this.heroRating) {
      this.heroRating.textContent = '';
    }
    this.heroEpisodes.textContent = drama.episodes ? `${drama.episodes} ตอน (${drama.language || 'ครบทุกตอน'})` : 'ครบทุกตอน';
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

      const isGoSeries = drama.provider === 'goseries4k' || String(drama.id).startsWith('gs-');
      const primaryGenre = (drama.genre && drama.genre.length) ? drama.genre[0] : (isGoSeries ? 'ซีรีส์ 4K' : 'หนังสั้นจีน');
      const hasDub = (drama.language && drama.language.includes('พากย์')) || (drama.genre && drama.genre.includes('พากย์ไทย'));
      const hasSub = (drama.language && drama.language.includes('ซับ')) || (drama.genre && drama.genre.includes('ซับไทย'));
      let badgeText = 'พากย์ไทย';
      let badgeColor = 'background: rgba(37, 99, 235, 0.9);';
      if (hasDub && hasSub) {
        badgeText = 'พากย์+ซับ';
        badgeColor = 'background: linear-gradient(135deg, #ea580c, #2563eb);';
      } else if (hasSub && !hasDub) {
        badgeText = 'ซับไทย';
        badgeColor = 'background: rgba(16, 185, 129, 0.9);';
      }

      const sid = drama.series_id || drama.post_id || (drama.id ? drama.id.replace(/^(ry|gs)-/, '') : '100309804');
      const fallbackPoster = drama.remote_cover || `/api/proxy-image?sid=${drama.id || sid}`;
      const epText = drama.episodes ? `${drama.episodes} ตอน` : 'ครบทุกตอน';
      const isFav = this.favoritesSet.has(drama.id);
      const provTagClass = isGoSeries ? 'goseries4k' : 'rongyok';
      const provTagLabel = isGoSeries ? '4K HD' : 'SHORT';

      card.innerHTML = `
        <div class="card-poster-wrap">
          <img class="card-poster" src="${drama.cover || fallbackPoster}" alt="${drama.title}" loading="lazy" referrerpolicy="no-referrer" data-sid="${sid}" onerror="this.onerror=null; this.src='${fallbackPoster}';">
          <span class="card-badge-top" style="${badgeColor}">${badgeText}</span>
          <button class="card-fav-btn ${isFav ? 'favorited' : ''}" data-fav-id="${drama.id}" title="รายการโปรด">${isFav ? '❤️' : '🤍'}</button>
          <span class="card-provider-tag ${provTagClass}">${provTagLabel}</span>
          <span class="card-ep-counter" data-ep-sid="${sid}">${epText}</span>
        </div>
        <div class="card-content">
          <h3 class="card-title" title="${drama.title}">${drama.title}</h3>
          <span class="card-genre">${primaryGenre}</span>
        </div>
      `;

      const favBtn = card.querySelector('.card-fav-btn');
      if (favBtn) {
        favBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFavorite(drama.id, drama.title);
        });
      }

      card.addEventListener('click', () => {
        const lastEp = this.getLastWatchedEpisode(drama.id) || 1;
        this.openDrama(drama, lastEp);
      });

      this.cardsGrid.appendChild(card);
    });
  }

  performSearch(keyword, scrollToTop = false) {
    const cleanQuery = (keyword || '').trim();
    if (!cleanQuery) {
      this.exitSearchMode(true);
      return;
    }

    this.isSearchMode = true;
    this.activeSearchQuery = cleanQuery;

    if (this.viewPlayer && this.viewPlayer.classList.contains('active')) {
      this.showFeedView();
    }

    if (this.heroBanner) {
      this.heroBanner.classList.add('hidden');
    }
    if (this.sectionContinue) {
      this.sectionContinue.classList.add('hidden');
    }
    if (this.gridTitle) {
      this.gridTitle.textContent = `🔍 ผลการค้นหา: "${cleanQuery}"`;
    }

    const qLower = cleanQuery.toLowerCase();
    const tokens = qLower.split(/\s+/).filter(Boolean);

    const matchAndScore = (d) => {
      const title = (d.title || '').toLowerCase();
      const synopsis = (d.synopsis || '').toLowerCase();
      const engTitle = (d.english_title || '').toLowerCase();
      const lang = (d.language || '').toLowerCase();
      const sid = String(d.series_id || d.id || d.slug || '').toLowerCase();
      const genres = Array.isArray(d.genre) ? d.genre.map(g => g.toLowerCase()).join(' ') : '';
      const combined = `${title} ${genres} ${lang} ${synopsis} ${engTitle} ${sid}`;

      const allTokensMatch = tokens.every(t => combined.includes(t));
      if (!allTokensMatch && !combined.includes(qLower)) {
        return 0;
      }

      let score = 1;
      if (title === qLower || sid === qLower) score += 100;
      else if (title.startsWith(qLower)) score += 50;
      else if (title.includes(qLower)) score += 30;
      else if (tokens.every(t => title.includes(t))) score += 20;
      if (genres.includes(qLower)) score += 10;
      return score;
    };

    const sourceList = (this.masterCatalog && this.masterCatalog.length > 0)
      ? this.masterCatalog
      : this.allDramas;

    let localResults = [];
    if (sourceList && sourceList.length > 0) {
      let pool = sourceList;
      if (this.currentProvider === 'goseries4k') {
        pool = pool.filter(d => d.provider === 'goseries4k');
      } else if (this.currentProvider === 'rongyok') {
        pool = pool.filter(d => d.provider !== 'goseries4k');
      } else if (this.currentProvider === 'favorites') {
        pool = pool.filter(d => this.favoritesSet.has(d.id));
      }

      if (this.currentLang === 'dubbed') {
        pool = pool.filter(d => (d.language && d.language.includes('พากย์ไทย')) || (d.genre && d.genre.includes('พากย์ไทย')));
      } else if (this.currentLang === 'subbed') {
        pool = pool.filter(d => (d.language && d.language.includes('ซับไทย')) || (d.genre && d.genre.includes('ซับไทย')));
      }

      const scored = [];
      for (const d of pool) {
        const s = matchAndScore(d);
        if (s > 0) {
          scored.push({ drama: d, score: s });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      localResults = scored.map(item => item.drama);

      this.renderDramaGrid(localResults, false);
      this.gridCounter.textContent = `${localResults.length} เรื่อง`;
      this.wrapLoadMore.classList.add('hidden');

      if (scrollToTop || window.scrollY > 220) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    // Live search across GoSeries4K WP REST API + RongYok AJAX if < 8 local matches
    if (!this.masterCatalog || this.masterCatalog.length === 0 || localResults.length < 8) {
      fetch(`/api/search?q=${encodeURIComponent(cleanQuery)}`)
        .then(res => res.json())
        .then(data => {
          if (!this.isSearchMode || this.activeSearchQuery !== cleanQuery) return;
          if (data && data.status && Array.isArray(data.results)) {
            const seen = new Set(localResults.map(d => d.id || `ry-${d.series_id}`));
            const merged = [...localResults];
            for (const item of data.results) {
              const key = item.id || `ry-${item.series_id}`;
              if (!seen.has(key)) {
                seen.add(key);
                merged.push(item);
              }
            }
            this.renderDramaGrid(merged, false);
            this.gridCounter.textContent = `${merged.length} เรื่อง`;
            this.wrapLoadMore.classList.add('hidden');
          }
        })
        .catch(e => console.warn('Search API fallback error:', e));
    }
  }

  async openDrama(drama, epNum = 1) {
    this.activeDrama = drama;
    this.activeLangTrack = '';
    this.episodesByLang = {};
    this.activeEpisodeList = [];
    this.showPlayerView();

    const isGoSeries = drama.provider === 'goseries4k' || String(drama.id).startsWith('gs-');
    this.sideTitle.textContent = drama.title;
    this.sideProvider.textContent = isGoSeries ? 'GOSERIES 4K' : 'RONGYOK';
    this.sideProvider.style.background = isGoSeries ? 'rgba(249, 115, 22, 0.25)' : 'rgba(16, 185, 129, 0.25)';
    this.sideProvider.style.color = isGoSeries ? '#fb923c' : '#34d399';
    if (this.sideRating) {
      this.sideRating.textContent = '';
    }
    this.sideSynopsis.textContent = drama.synopsis || 'ไม่มีเรื่องย่อ';
    this.updateSidebarFavButton();

    // Load Episode Buttons (and Dual-Audio Tracks if GoSeries4K)
    await this.loadEpisodeButtons(drama, epNum);

    // Load Video Stream
    this.player.loadEpisode(drama, epNum, this.activeLangTrack);

    // Load Viewer Comments if GoSeries4K
    if (isGoSeries) {
      this.loadGoSeriesComments(drama.post_id || drama.series_id);
    } else if (this.commentsSection) {
      this.commentsSection.classList.add('hidden');
    }
  }

  async loadEpisodeButtons(drama, activeEp = 1) {
    this.episodesGrid.innerHTML = '<div style="color: #9ca3af; padding: 10px;">กำลังโหลดรายชื่อตอน...</div>';
    if (this.drawerGrid) {
      this.drawerGrid.innerHTML = '<div style="color: #9ca3af; padding: 10px; grid-column: span 5; text-align: center;">กำลังโหลดรายชื่อตอน...</div>';
    }

    const isGoSeries = drama.provider === 'goseries4k' || String(drama.id).startsWith('gs-');
    let total = drama.episodes || 0;
    let epData = null;

    try {
      const res = await fetch(`/api/episodes/${encodeURIComponent(drama.id)}?provider=${isGoSeries ? 'goseries4k' : 'rongyok'}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.status) {
          epData = data;
          if (data.synopsis && (!drama.synopsis || drama.synopsis.length < 30)) {
            drama.synopsis = data.synopsis;
            this.sideSynopsis.textContent = data.synopsis;
          }
          if (data.post_id && !drama.post_id) {
            drama.post_id = data.post_id;
          }
        }
      }
    } catch (e) {}

    if (isGoSeries && epData && epData.episodes_by_lang && Object.keys(epData.episodes_by_lang).length > 0) {
      this.episodesByLang = epData.episodes_by_lang;
      const tracks = epData.audio_tracks || Object.keys(this.episodesByLang);
      this.activeLangTrack = epData.active_lang || tracks[0];
      this.renderAudioTrackSwitcher(tracks, drama);
      this.activeEpisodeList = this.episodesByLang[this.activeLangTrack] || [];
      total = this.activeEpisodeList.length || 1;
      drama.episodes = total;
    } else {
      const fallbackTrack = (drama.language && drama.language.includes('ซับ')) ? 'ซับไทย' : 'พากย์ไทย';
      this.activeLangTrack = fallbackTrack;
      if (epData && Array.isArray(epData.episodes) && epData.episodes.length > 0) {
        this.activeEpisodeList = epData.episodes;
        if (epData.source !== 'fallback' || !total) {
          total = epData.episodes.length;
          drama.episodes = total;
        }
      }
      this.episodesByLang = { [fallbackTrack]: this.activeEpisodeList };
      this.renderAudioTrackSwitcher([fallbackTrack], drama);
    }

    if (!total) total = isGoSeries ? 1 : 60;
    this.renderEpisodeGridButtons(drama, total, activeEp);
  }

  renderAudioTrackSwitcher(tracks, drama) {
    const hasTracks = Array.isArray(tracks) && tracks.length > 0;

    if (!hasTracks) {
      if (this.audioTrackSection) this.audioTrackSection.classList.add('hidden');
      if (this.overlayAudioButtons) this.overlayAudioButtons.classList.add('hidden');
      if (this.drawerAudioSection) this.drawerAudioSection.classList.add('hidden');
      return;
    }

    if (this.audioTrackSection) this.audioTrackSection.classList.remove('hidden');
    if (this.overlayAudioButtons) this.overlayAudioButtons.classList.remove('hidden');
    if (this.drawerAudioSection) this.drawerAudioSection.classList.remove('hidden');

    if (this.audioTrackButtons) this.audioTrackButtons.innerHTML = '';
    if (this.overlayAudioButtons) this.overlayAudioButtons.innerHTML = '';
    if (this.drawerAudioButtons) this.drawerAudioButtons.innerHTML = '';

    const switchTrack = (trackName) => {
      if (this.activeLangTrack === trackName) return;
      this.activeLangTrack = trackName;

      document.querySelectorAll('[data-audio-track]').forEach(b => {
        b.classList.toggle('active', b.dataset.audioTrack === trackName);
      });

      this.activeEpisodeList = this.episodesByLang[trackName] || [];
      const newTotal = this.activeEpisodeList.length || drama.episodes || 1;
      drama.episodes = newTotal;
      const targetEp = Math.min(this.player.currentEp || 1, newTotal);
      this.renderEpisodeGridButtons(drama, newTotal, targetEp);
      this.player.loadEpisode(drama, targetEp, trackName);
      this.showToast(`เปลี่ยนเสียงเป็น: ${trackName}`);
    };

    tracks.forEach(trackName => {
      const icon = trackName.includes('พากย์') ? '🎙️' : '💬';
      const count = (this.episodesByLang[trackName] || []).length || drama.episodes || 1;
      const isActive = trackName === this.activeLangTrack;

      // 1. Sidebar / Mobile Below-Player Button
      if (this.audioTrackButtons) {
        const btn = document.createElement('button');
        btn.className = `audio-track-btn ${isActive ? 'active' : ''}`;
        btn.dataset.audioTrack = trackName;
        btn.textContent = `${icon} ${trackName} (${count} ตอน)`;
        btn.addEventListener('click', () => switchTrack(trackName));
        this.audioTrackButtons.appendChild(btn);
      }

      // 2. Floating Video Top Overlay Pill Button (always visible on mobile & fullscreen)
      if (this.overlayAudioButtons) {
        const oBtn = document.createElement('button');
        oBtn.className = `overlay-audio-pill ${isActive ? 'active' : ''}`;
        oBtn.dataset.audioTrack = trackName;
        oBtn.textContent = `${icon} ${trackName}`;
        oBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          switchTrack(trackName);
        });
        this.overlayAudioButtons.appendChild(oBtn);
      }

      // 3. Mobile Bottom Sheet Episode Drawer Button
      if (this.drawerAudioButtons) {
        const dBtn = document.createElement('button');
        dBtn.className = `audio-track-btn ${isActive ? 'active' : ''}`;
        dBtn.dataset.audioTrack = trackName;
        dBtn.textContent = `${icon} ${trackName} (${count} ตอน)`;
        dBtn.addEventListener('click', () => switchTrack(trackName));
        this.drawerAudioButtons.appendChild(dBtn);
      }
    });
  }

  renderEpisodeGridButtons(drama, total, activeEp = 1) {
    this.sideTotal.textContent = `${total} ตอน`;
    this.epCountLbl.textContent = total;
    if (this.drawerEpCount) this.drawerEpCount.textContent = total;

    this.episodesGrid.innerHTML = '';
    if (this.drawerGrid) this.drawerGrid.innerHTML = '';

    const watchedList = JSON.parse(localStorage.getItem(`shortflix_watched_${drama.id}`) || '[]');

    for (let idx = 0; idx < total; idx++) {
      const epObj = this.activeEpisodeList[idx];
      const ep = epObj ? parseInt(epObj.episode, 10) : (idx + 1);
      const epMd5 = epObj && epObj.md5 ? epObj.md5 : '';

      const btn = document.createElement('button');
      btn.className = `ep-btn ${ep === activeEp ? 'active' : ''} ${watchedList.includes(ep) ? 'watched' : ''}`;
      btn.dataset.ep = ep;
      btn.textContent = `Ep.${ep}`;
      btn.addEventListener('click', () => {
        this.player.loadEpisode(drama, ep, this.activeLangTrack, epMd5);
      });
      this.episodesGrid.appendChild(btn);

      if (this.drawerGrid) {
        const mBtn = document.createElement('button');
        mBtn.className = `ep-btn ${ep === activeEp ? 'active' : ''} ${watchedList.includes(ep) ? 'watched' : ''}`;
        mBtn.dataset.ep = ep;
        mBtn.textContent = `Ep.${ep}`;
        mBtn.addEventListener('click', () => {
          this.player.loadEpisode(drama, ep, this.activeLangTrack, epMd5);
          this.closeEpisodeDrawer();
        });
        this.drawerGrid.appendChild(mBtn);
      }
    }
  }

  async loadGoSeriesComments(postId) {
    if (!this.commentsSection || !this.commentsList || !postId) {
      if (this.commentsSection) this.commentsSection.classList.add('hidden');
      return;
    }

    try {
      const res = await fetch(`/api/goseries/comments/${postId}`);
      if (!res.ok) throw new Error('Failed to fetch comments');
      const json = await res.json();
      const comments = (json && json.data && Array.isArray(json.data.comments)) ? json.data.comments : [];
      if (comments.length === 0) {
        this.commentsSection.classList.add('hidden');
        return;
      }

      this.commentsSection.classList.remove('hidden');
      if (this.commentsCountLbl) this.commentsCountLbl.textContent = comments.length;
      this.commentsList.innerHTML = '';

      comments.slice(0, 15).forEach(c => {
        const div = document.createElement('div');
        div.className = 'comment-item';
        const author = c.author_name || c.display_name || 'ผู้ชม GoSeries4K';
        const dateStr = c.created_at || '';
        div.innerHTML = `
          <div class="comment-meta">
            <strong>👤 ${author}</strong>
            <span>${dateStr}</span>
          </div>
          <div>${c.content || ''}</div>
        `;
        this.commentsList.appendChild(div);
      });
    } catch (e) {
      this.commentsSection.classList.add('hidden');
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
        slug: drama.slug,
        post_id: drama.post_id,
        series_id: drama.series_id,
        title: drama.title,
        cover: drama.cover,
        provider: drama.provider || 'rongyok',
        aspect_ratio: drama.aspect_ratio || (drama.provider === 'goseries4k' ? '16:9' : '9:16'),
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
      if (this.isSearchMode) {
        this.sectionContinue.classList.add('hidden');
        return;
      }
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
          const fullDrama = (this.masterCatalog || []).find(d => d.id === item.id) || item;
          this.openDrama(fullDrama, item.lastEp);
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
