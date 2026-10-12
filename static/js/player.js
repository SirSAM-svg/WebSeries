/**
 * SO+ SERIES & 4K MOVIES - ADAPTIVE VIDEO PLAYER CONTROLLER
 * Handles HLS.js streaming (.m3u8 via Torbo007/GoSeries4K proxy) & MP4 (RongYok),
 * 16:9 Widescreen + 9:16 Vertical aspect modes, dual-audio switching, gesture controls, and watch history.
 */

class VerticalPlayer {
  constructor() {
    this.video = document.getElementById('video-element');
    this.screenContainer = document.getElementById('screen-container');
    this.playerMainStage = document.getElementById('player-main-stage');
    this.loader = document.getElementById('video-loader');
    this.playOverlay = document.getElementById('play-overlay');
    this.scrubber = document.getElementById('video-scrubber');
    this.timeCurrent = document.getElementById('time-current');
    this.timeDuration = document.getElementById('time-duration');
    this.btnPlayToggle = document.getElementById('btn-play-toggle');
    this.iconPlay = document.getElementById('icon-play');
    this.iconPause = document.getElementById('icon-pause');
    this.btnMuteToggle = document.getElementById('btn-mute-toggle');
    this.chkAutoplay = document.getElementById('chk-autoplay');
    this.btnAspectToggle = document.getElementById('btn-aspect-toggle');
    this.btnSpeed = document.getElementById('btn-speed');
    this.btnFullscreen = document.getElementById('btn-fullscreen');
    this.btnFloatingNext = document.getElementById('btn-floating-next');
    this.btnFloatingPrev = document.getElementById('btn-floating-prev');
    this.overlayEpTitle = document.getElementById('overlay-ep-title');
    this.overlayProvider = document.getElementById('overlay-provider');
    this.rippleLeft = document.getElementById('seek-ripple-left');
    this.rippleRight = document.getElementById('seek-ripple-right');

    this.currentDrama = null;
    this.currentEp = 1;
    this.currentLangTrack = '';
    this.currentMd5 = '';
    this.totalEpisodes = 1;
    this.aspectMode = '9:16';
    this.hls = null;
    this.speeds = [1.0, 1.25, 1.5, 2.0];
    this.speedIndex = 0;
    this.lastHistorySync = 0;

    this.initEvents();
  }

  setAspectRatio(mode = '9:16') {
    this.aspectMode = mode;
    const isWide = mode === '16:9';
    if (this.playerMainStage) {
      this.playerMainStage.classList.toggle('widescreen-mode', isWide);
    }
    if (this.screenContainer) {
      this.screenContainer.classList.toggle('widescreen-frame', isWide);
    }
    if (this.btnAspectToggle) {
      this.btnAspectToggle.textContent = isWide ? '16:9' : '9:16';
    }
  }

  showSeekRipple(direction) {
    const el = direction === 'left' ? this.rippleLeft : this.rippleRight;
    if (el) {
      el.classList.remove('hidden');
      clearTimeout(el.rippleTimer);
      el.rippleTimer = setTimeout(() => {
        el.classList.add('hidden');
      }, 550);
    }
  }

  initEvents() {
    if (!this.video) return;

    // Aspect ratio toggle button (16:9 <-> 9:16)
    if (this.btnAspectToggle) {
      this.btnAspectToggle.addEventListener('click', () => {
        const nextMode = this.aspectMode === '16:9' ? '9:16' : '16:9';
        this.setAspectRatio(nextMode);
        if (window.app) {
          window.app.showToast(`สัดส่วนหน้าจอ: ${nextMode}`);
        }
      });
    }

    // Fullscreen change listener
    const handleFullscreenChange = () => {
      const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
      this.screenContainer.classList.toggle('pc-fullscreen-active', isFull);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    // Double-tap Seek / Single-tap Play listener on Video
    let lastTapTime = 0;
    let singleTapTimeout = null;

    this.video.addEventListener('click', (e) => {
      const now = Date.now();
      const rect = this.video.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const widthPct = clickX / rect.width;

      if (now - lastTapTime < 320) {
        clearTimeout(singleTapTimeout);
        if (widthPct < 0.35) {
          this.video.currentTime = Math.max(0, this.video.currentTime - 5);
          this.showSeekRipple('left');
        } else if (widthPct > 0.65) {
          this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 5);
          this.showSeekRipple('right');
        } else {
          this.btnFullscreen.click();
        }
      } else {
        singleTapTimeout = setTimeout(() => {
          this.togglePlay();
        }, 280);
      }
      lastTapTime = now;
    });

    this.playOverlay.addEventListener('click', () => this.togglePlay());
    this.btnPlayToggle.addEventListener('click', () => this.togglePlay());

    // Playback state listeners
    this.video.addEventListener('play', () => {
      this.iconPlay.classList.add('hidden');
      this.iconPause.classList.remove('hidden');
      this.playOverlay.classList.add('hidden');
    });

    this.video.addEventListener('pause', () => {
      this.iconPlay.classList.remove('hidden');
      this.iconPause.classList.add('hidden');
      this.playOverlay.classList.remove('hidden');
    });

    this.video.addEventListener('waiting', () => {
      this.loader.classList.remove('hidden');
    });

    this.video.addEventListener('playing', () => {
      this.loader.classList.add('hidden');
    });

    this.video.addEventListener('canplay', () => {
      this.loader.classList.add('hidden');
    });

    // Time update & scrubber
    this.video.addEventListener('timeupdate', () => {
      if (!this.video.duration) return;
      const progress = (this.video.currentTime / this.video.duration) * 100;
      this.scrubber.value = progress;
      this.timeCurrent.textContent = this.formatTime(this.video.currentTime);
      this.timeDuration.textContent = this.formatTime(this.video.duration);

      if (this.currentDrama) {
        this.savePlaybackProgress(
          this.currentDrama.id,
          this.currentEp,
          this.video.currentTime,
          this.video.duration
        );
      }
    });

    this.scrubber.addEventListener('input', (e) => {
      if (!this.video.duration) return;
      const seekTime = (e.target.value / 100) * this.video.duration;
      this.video.currentTime = seekTime;
    });

    // Next Episode on ended
    this.video.addEventListener('ended', () => {
      this.markEpisodeWatched(this.currentDrama.id, this.currentEp);
      if (this.chkAutoplay.checked) {
        if (this.currentEp < this.totalEpisodes) {
          window.app.showToast(`เล่นตอนถัดไป: ตอนที่ ${this.currentEp + 1}`);
          this.nextEpisode();
        } else {
          window.app.showToast('จบเรื่องแล้ว 🎉');
        }
      }
    });

    // Mute toggle
    this.btnMuteToggle.addEventListener('click', () => {
      this.video.muted = !this.video.muted;
      this.btnMuteToggle.style.opacity = this.video.muted ? '0.5' : '1';
    });

    // Playback Speed
    this.btnSpeed.addEventListener('click', () => {
      this.speedIndex = (this.speedIndex + 1) % this.speeds.length;
      const speed = this.speeds[this.speedIndex];
      this.video.playbackRate = speed;
      this.btnSpeed.textContent = `${speed.toFixed(1)}x`;
    });

    // Fullscreen
    this.btnFullscreen.addEventListener('click', () => {
      const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!isFull) {
        if (this.screenContainer.requestFullscreen) {
          this.screenContainer.requestFullscreen();
        } else if (this.screenContainer.webkitRequestFullscreen) {
          this.screenContainer.webkitRequestFullscreen();
        } else if (this.video.webkitEnterFullscreen) {
          this.video.webkitEnterFullscreen();
        }
        try {
          if (screen.orientation && screen.orientation.lock) {
            const lockMode = this.aspectMode === '16:9' ? 'landscape' : 'portrait';
            screen.orientation.lock(lockMode).catch(() => {});
          }
        } catch (e) {}
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    });

    // Inactivity timer for immersive playback
    let inactiveTimer = null;
    const resetInactiveTimer = () => {
      this.screenContainer.classList.remove('user-inactive');
      clearTimeout(inactiveTimer);
      if (!this.video.paused) {
        inactiveTimer = setTimeout(() => {
          this.screenContainer.classList.add('user-inactive');
        }, 3000);
      }
    };

    this.screenContainer.addEventListener('mousemove', resetInactiveTimer);
    this.screenContainer.addEventListener('touchstart', resetInactiveTimer, { passive: true });
    this.video.addEventListener('play', resetInactiveTimer);
    this.video.addEventListener('pause', () => {
      clearTimeout(inactiveTimer);
      this.screenContainer.classList.remove('user-inactive');
    });

    // Floating Controls
    this.btnFloatingNext.addEventListener('click', () => this.nextEpisode());
    this.btnFloatingPrev.addEventListener('click', () => this.prevEpisode());

    // Keyboard controls
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const playerView = document.getElementById('view-player');
      if (!playerView || !playerView.classList.contains('active')) return;

      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.nextEpisode();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.prevEpisode();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.video.currentTime = Math.max(0, this.video.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 5);
          break;
        case 'KeyM':
          this.video.muted = !this.video.muted;
          break;
        case 'KeyF':
          this.btnFullscreen.click();
          break;
      }
    });

    // Touch Swipe gestures (Up = Next, Down = Prev)
    let touchStartY = 0;
    this.screenContainer.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    this.screenContainer.addEventListener('touchend', (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      const diffY = touchStartY - touchEndY;
      if (diffY > 60) {
        this.nextEpisode();
      } else if (diffY < -60) {
        this.prevEpisode();
      }
    }, { passive: true });
  }

  togglePlay() {
    if (this.video.paused) {
      this.video.play().catch(e => console.log('Autoplay prevented:', e));
    } else {
      this.video.pause();
    }
  }

  nextEpisode() {
    if (this.currentEp < this.totalEpisodes) {
      this.loadEpisode(this.currentDrama, this.currentEp + 1, this.currentLangTrack);
    } else {
      window.app.showToast('นี่คือตอนสุดท้ายแล้ว');
    }
  }

  prevEpisode() {
    if (this.currentEp > 1) {
      this.loadEpisode(this.currentDrama, this.currentEp - 1, this.currentLangTrack);
    } else {
      window.app.showToast('นี่คือตอนแรกแล้ว');
    }
  }

  async loadEpisode(drama, epNum = 1, langTrack = '', md5Hash = '') {
    if (!drama) return;
    this.currentDrama = drama;
    this.currentEp = parseInt(epNum, 10);
    this.totalEpisodes = drama.episodes || 60;
    if (langTrack) {
      this.currentLangTrack = langTrack;
    } else if (!this.currentLangTrack && drama.audio_tracks && drama.audio_tracks.length > 0) {
      this.currentLangTrack = drama.audio_tracks[0];
    }

    // Automatically select 16:9 for GoSeries4K movies/series, 9:16 for RongYok short dramas
    const isGoSeries = drama.provider === 'goseries4k' || (drama.id && String(drama.id).startsWith('gs-')) || drama.aspect_ratio === '16:9';
    this.setAspectRatio(isGoSeries ? '16:9' : '9:16');

    // Look up md5 from active episode list if available
    let resolvedMd5 = md5Hash;
    if (!resolvedMd5 && window.app && Array.isArray(window.app.activeEpisodeList)) {
      const epObj = window.app.activeEpisodeList.find(e => parseInt(e.episode, 10) === this.currentEp);
      if (epObj && epObj.md5) {
        resolvedMd5 = epObj.md5;
      }
    }
    this.currentMd5 = resolvedMd5 || '';

    // Update overlay tags
    const langSuffix = (isGoSeries && this.currentLangTrack) ? ` (${this.currentLangTrack})` : '';
    this.overlayEpTitle.textContent = `ตอนที่ ${this.currentEp}${langSuffix}`;
    this.overlayProvider.textContent = isGoSeries ? 'GOSERIES 4K' : 'RONGYOK';

    // Update Floating Buttons state
    this.btnFloatingPrev.style.opacity = this.currentEp > 1 ? '1' : '0.4';
    this.btnFloatingNext.style.opacity = this.currentEp < this.totalEpisodes ? '1' : '0.4';

    // Show loading spinner
    this.loader.classList.remove('hidden');

    if (window.app) {
      window.app.updateSidebarActiveEpisode(this.currentEp);
    }

    try {
      const provider = isGoSeries ? 'goseries4k' : (drama.provider || 'rongyok');
      const params = new URLSearchParams({ provider });
      if (this.currentLangTrack) params.set('lang', this.currentLangTrack);
      if (this.currentMd5) params.set('md5', this.currentMd5);

      const playBase = (typeof window !== 'undefined' && window.PLAY_SERVER) ? window.PLAY_SERVER.replace(/\/$/, '') : '';
      const relUrl = `/api/play/${encodeURIComponent(drama.id)}/${this.currentEp}?${params.toString()}`;
      const urlsToTry = playBase ? [`${playBase}${relUrl}`, relUrl] : [relUrl];

      let data = null;
      let lastErr = null;
      for (const targetUrl of urlsToTry) {
        try {
          const res = await fetch(targetUrl);
          if (res.ok) {
            data = await res.json();
            if (data && data.status && data.stream && data.stream.streamUrl) {
              break;
            }
          } else {
            const errJson = await res.json().catch(() => ({}));
            lastErr = new Error(errJson.error || `HTTP ${res.status}`);
          }
        } catch (fetchErr) {
          lastErr = fetchErr;
        }
      }

      if (data && data.status && data.stream && data.stream.streamUrl) {
        const streamUrl = data.stream.streamUrl;
        const format = data.stream.format || (streamUrl.includes('.m3u8') ? 'HLS' : 'MP4');
        this.playStream(streamUrl, format);
      } else {
        throw lastErr || new Error('ไม่พบสตรีมวิดีโอ');
      }
    } catch (err) {
      console.error('[PLAYER LOAD ERROR]', err);
      this.loader.classList.add('hidden');
      if (window.app) {
        window.app.showToast(`เล่นไม่ได้: ${err.message}`);
      }
    }

    this.markEpisodeWatched(drama.id, this.currentEp);
    if (window.app) {
      window.app.saveContinueWatching(drama, this.currentEp);
    }
  }

  playStream(streamUrl, format = 'HLS') {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    const isHls = format === 'HLS' || streamUrl.includes('.m3u8');
    if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        maxBufferLength: 45,
      });
      this.hls.loadSource(streamUrl);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.restoreSavedPosition();
        this.video.play().catch(() => {
          this.playOverlay.classList.remove('hidden');
        });
      });
      this.hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.hls.recoverMediaError();
              break;
            default:
              this.hls.destroy();
              break;
          }
        }
      });
    } else {
      this.video.src = streamUrl;
      this.video.load();
      this.video.addEventListener('loadedmetadata', () => this.restoreSavedPosition(), { once: true });
      this.video.play().catch(() => {
        this.playOverlay.classList.remove('hidden');
      });
    }
  }

  restoreSavedPosition() {
    try {
      if (!this.currentDrama) return;
      const key = `shortflix_progress_${this.currentDrama.id}_${this.currentEp}`;
      const saved = parseFloat(localStorage.getItem(key) || '0');
      if (saved > 5 && (!this.video.duration || saved < this.video.duration - 10)) {
        this.video.currentTime = saved;
      }
    } catch (e) {}
  }

  formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  markEpisodeWatched(dramaId, epNum) {
    try {
      const key = `shortflix_watched_${dramaId}`;
      let watched = JSON.parse(localStorage.getItem(key) || '[]');
      if (!watched.includes(epNum)) {
        watched.push(epNum);
        localStorage.setItem(key, JSON.stringify(watched));
      }
      if (window.app) {
        window.app.refreshWatchedButtons(dramaId);
      }
    } catch (e) {}
  }

  savePlaybackProgress(dramaId, epNum, time, duration = 0) {
    try {
      localStorage.setItem(`shortflix_progress_${dramaId}_${epNum}`, time.toFixed(1));
      const now = Date.now();
      if (now - this.lastHistorySync > 12000) {
        this.lastHistorySync = now;
        fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            drama_id: dramaId,
            episode: epNum,
            position_seconds: Math.floor(time),
            duration_seconds: Math.floor(duration || 0),
          }),
        }).catch(() => {});
      }
    } catch (e) {}
  }
}

window.VerticalPlayer = VerticalPlayer;
