/**
 * SHORTFLIX - VERTICAL VIDEO PLAYER CONTROLLER
 * Handles HLS.js streaming (.m3u8), gesture controls, episode switching, and history.
 */

class VerticalPlayer {
  constructor() {
    this.video = document.getElementById('video-element');
    this.screenContainer = document.getElementById('screen-container');
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
    this.totalEpisodes = 1;
    this.hls = null;
    this.speeds = [1.0, 1.25, 1.5, 2.0];
    this.speedIndex = 0;

    this.initEvents();
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

    // Fullscreen change listener for True 9:16 PC mode
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

      // Save continue watching progress periodically
      if (this.currentDrama) {
        this.savePlaybackProgress(this.currentDrama.id, this.currentEp, this.video.currentTime);
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

    // Fullscreen (Vertical 9:16)
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
            screen.orientation.lock('portrait').catch(() => {});
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
      // Don't capture when typing in search input
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
        // Swiped UP -> Next Episode
        this.nextEpisode();
      } else if (diffY < -60) {
        // Swiped DOWN -> Prev Episode
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
      this.loadEpisode(this.currentDrama, this.currentEp + 1);
    } else {
      window.app.showToast('นี่คือตอนสุดท้ายแล้ว');
    }
  }

  prevEpisode() {
    if (this.currentEp > 1) {
      this.loadEpisode(this.currentDrama, this.currentEp - 1);
    } else {
      window.app.showToast('นี่คือตอนแรกแล้ว');
    }
  }

  async loadEpisode(drama, epNum = 1) {
    if (!drama) return;
    this.currentDrama = drama;
    this.currentEp = parseInt(epNum, 10);
    this.totalEpisodes = drama.episodes || 60;

    // Update overlay tags
    this.overlayEpTitle.textContent = `ตอนที่ ${this.currentEp}`;
    this.overlayProvider.textContent = (drama.provider || 'dramabox').toUpperCase();

    // Update Floating Buttons state
    this.btnFloatingPrev.style.opacity = this.currentEp > 1 ? '1' : '0.4';
    this.btnFloatingNext.style.opacity = this.currentEp < this.totalEpisodes ? '1' : '0.4';

    // Show loading spinner
    this.loader.classList.remove('hidden');

    // Update Sidebar active episode button
    if (window.app) {
      window.app.updateSidebarActiveEpisode(this.currentEp);
    }

    try {
      const provider = drama.provider || 'rongyok';
      const res = await fetch(`/api/play/${drama.id}/${this.currentEp}?provider=${provider}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      if (data.status && data.stream && data.stream.streamUrl) {
        const streamUrl = data.stream.streamUrl;
        const format = data.stream.format || (streamUrl.includes('.m3u8') ? 'HLS' : 'MP4');
        this.playStream(streamUrl, format);
      } else {
        throw new Error('No stream data');
      }
    } catch (err) {
      console.warn('Primary edge play fetch error, trying secondary source:', err);
      try {
        const sid = drama.series_id || (drama.id && drama.id.replace('ry-', ''));
        const pRes = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(`https://rongyok.com/watch/playseries.php?series_id=${sid}&ep=${this.currentEp}`)}`);
        const pData = await pRes.json();
        if (pData && pData.ok && pData.video_url) {
          this.playStream(pData.video_url, 'MP4');
          return;
        }
      } catch (proxyErr) {
        console.warn('Secondary fallback failed:', proxyErr);
      }

      this.loader.classList.add('hidden');
      if (window.app) {
        window.app.showToast('ไม่สามารถเชื่อมต่อสัญญาณวิดีโอได้ชั่วคราว');
      }
    }

    // Mark current episode in history
    this.markEpisodeWatched(drama.id, this.currentEp);
    if (window.app) {
      window.app.saveContinueWatching(drama, this.currentEp);
    }
  }

  playStream(streamUrl, format = 'HLS') {
    // Destroy previous HLS instance if any
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (streamUrl.includes('.m3u8') && Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });
      this.hls.loadSource(streamUrl);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.video.play().catch(e => {
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
      // Native MP4 or Safari native HLS
      this.video.src = streamUrl;
      this.video.load();
      this.video.play().catch(e => {
        this.playOverlay.classList.remove('hidden');
      });
    }
  }

  formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
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

  savePlaybackProgress(dramaId, epNum, time) {
    try {
      localStorage.setItem(`shortflix_progress_${dramaId}_${epNum}`, time.toFixed(1));
    } catch (e) {}
  }
}

window.VerticalPlayer = VerticalPlayer;
