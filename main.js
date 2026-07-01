/* ============================================================
Poweramp Web v3.0 - Professional Audio Processor
Revamped with Professional UI
============================================================ */

// ==================== CONFIGURATION ====================
const CONFIG = {
    EQ_FREQS: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000],
    EQ_Q: 1.4,
    PRESETS: {
        flat: new Array(15).fill(0),
        rock: [-2, 0, 2, 4, 6, 4, 2, 0, -1, -2, -3, -2, -1, 0, 2],
        metal: [4, 3, 0, -2, -3, -1, 0, 2, 4, 6, 5, 3, 2, 0, -2],
        pop: [-2, -1, 0, 2, 4, 6, 4, 2, 0, -1, -2, -1, 0, 1, 2],
        jazz: [2, 3, 4, 3, 2, 1, 0, -1, -2, -2, -1, 0, 1, 2, 3],
        electronic: [2, 3, 4, 5, 4, 2, 0, -1, -2, -2, 0, 2, 4, 5, 4],
        bass: [4, 5, 4, 3, 1, 0, -1, -2, -2, -1, 0, 0, 0, 0, 0],
        treble: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6],
        vocal: [-2, -1, 0, 2, 3, 4, 3, 2, 2, 1, 0, -1, -2, -1, 0],
        classical: [2, 2, 1, 0, -1, -2, -1, 0, 1, 2, 3, 2, 1, 0, 0]
    }
};

// ==================== AUDIO ENGINE ====================
class AudioEngine {
    constructor() {
        this.ctx = null;
        this.sourceNode = null;
        this.splitter = null;
        this.merger = null;
        this.nodes = { L: null, R: null };
        this.masterChain = null;
        this.initialized = false;
        this.isPlaying = false;
        this.currentSourceType = 'local';
        this.mediaElement = document.getElementById('audioPlayer');
        this.captureStream = null;
        this.captureSource = null;
        this.sampleRate = 44100;
    }

    init() {
        if (this.initialized) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext({ latencyHint: 'interactive' });
            this.sampleRate = this.ctx.sampleRate;

            this.splitter = this.ctx.createChannelSplitter(2);
            this.merger = this.ctx.createChannelMerger(2);

            this.nodes.L = this.createChannelChain('L', 0);
            this.nodes.R = this.createChannelChain('R', 1);

            this.masterChain = this.createMasterChain();

            this.splitter.connect(this.masterChain.input);
            this.masterChain.output.connect(this.ctx.destination);

            this.initialized = true;
            this.updateStatus('Audio processor ready');
        } catch (e) {
            console.error('Audio init error:', e);
            this.updateStatus('Error: ' + e.message);
        }
    }

    createChannelChain(channel, index) {
        const chain = {};

        // HPF cascaded
        chain.hpf = [];
        for (let i = 0; i < 4; i++) {
            const f = this.ctx.createBiquadFilter();
            f.type = 'highpass';
            f.frequency.value = 20;
            f.Q.value = 0.707;
            chain.hpf.push(f);
        }

        // LPF cascaded
        chain.lpf = [];
        for (let i = 0; i < 4; i++) {
            const f = this.ctx.createBiquadFilter();
            f.type = 'lowpass';
            f.frequency.value = 20000;
            f.Q.value = 0.707;
            chain.lpf.push(f);
        }

        // Sub boost
        chain.sub = this.ctx.createBiquadFilter();
        chain.sub.type = 'lowshelf';
        chain.sub.frequency.value = 100;
        chain.sub.gain.value = 0;

        // 15-band EQ
        chain.eq = CONFIG.EQ_FREQS.map(freq => {
            const f = this.ctx.createBiquadFilter();
            f.type = 'peaking';
            f.frequency.value = freq;
            f.Q.value = CONFIG.EQ_Q;
            f.gain.value = 0;
            return f;
        });

        // Delay
        chain.delay = this.ctx.createDelay(2);
        chain.delay.delayTime.value = 0;

        // Phase
        chain.phase = this.ctx.createGain();
        chain.phase.gain.value = 1;

        // Channel gain
        chain.channelGain = this.ctx.createGain();
        chain.channelGain.gain.value = 1;

        // Amp gain
        chain.ampGain = this.ctx.createGain();
        chain.ampGain.gain.value = 1;

        // Clipper
        chain.clipper = this.ctx.createWaveShaper();
        chain.clipper.curve = this.makeLinearCurve();
        chain.clipper.oversample = '4x';

        // Limiter
        chain.limiter = this.ctx.createDynamicsCompressor();
        chain.limiter.threshold.value = -3;
        chain.limiter.knee.value = 3;
        chain.limiter.ratio.value = 12;
        chain.limiter.attack.value = 0.003;
        chain.limiter.release.value = 0.1;

        // Analyser
        chain.analyser = this.ctx.createAnalyser();
        chain.analyser.fftSize = 2048;
        chain.analyser.smoothingTimeConstant = 0.7;

        // Connect chain
        this.splitter.connect(chain.hpf[0], index);
        for (let i = 0; i < chain.hpf.length - 1; i++) {
            chain.hpf[i].connect(chain.hpf[i + 1]);
        }
        const lastHpf = chain.hpf[chain.hpf.length - 1];
        lastHpf.connect(chain.lpf[0]);
        for (let i = 0; i < chain.lpf.length - 1; i++) {
            chain.lpf[i].connect(chain.lpf[i + 1]);
        }
        const lastLpf = chain.lpf[chain.lpf.length - 1];
        lastLpf.connect(chain.sub);

        let last = chain.sub;
        chain.eq.forEach(f => { last.connect(f); last = f; });
        last.connect(chain.delay);
        chain.delay.connect(chain.phase);
        chain.phase.connect(chain.channelGain);
        chain.channelGain.connect(chain.ampGain);
        chain.ampGain.connect(chain.clipper);
        chain.clipper.connect(chain.limiter);
        chain.limiter.connect(chain.analyser);
        chain.analyser.connect(this.merger, 0, index);

        return chain;
    }

    createMasterChain() {
        const input = this.ctx.createGain();
        input.gain.value = 1;

        const masterVolume = this.ctx.createGain();
        masterVolume.gain.value = 1;

        const masterGain = this.ctx.createGain();
        masterGain.gain.value = 1;

        const masterLimiter = this.ctx.createDynamicsCompressor();
        masterLimiter.threshold.value = -3;
        masterLimiter.knee.value = 6;
        masterLimiter.ratio.value = 20;
        masterLimiter.attack.value = 0.001;
        masterLimiter.release.value = 0.05;

        const masterAnalyser = this.ctx.createAnalyser();
        masterAnalyser.fftSize = 4096;
        masterAnalyser.smoothingTimeConstant = 0.8;

        input.connect(masterVolume);
        masterVolume.connect(masterGain);
        masterGain.connect(masterLimiter);
        masterLimiter.connect(masterAnalyser);

        return {
            input,
            masterVolume,
            masterGain,
            masterLimiter,
            masterAnalyser,
            output: masterAnalyser
        };
    }

    connectMediaElement(element) {
        if (!this.initialized) this.init();
        this.disconnectSource();
        this.currentSourceType = 'local';
        try {
            this.sourceNode = this.ctx.createMediaElementSource(element);
            this.sourceNode.connect(this.splitter);
            this.mediaElement = element;
        } catch (e) {
            if (!e.message.includes('already connected')) {
                console.warn('MediaElement connection:', e.message);
            }
        }
    }

    connectStream(stream) {
        if (!this.initialized) this.init();
        this.disconnectSource();
        this.currentSourceType = 'capture';
        this.captureStream = stream;
        this.captureSource = this.ctx.createMediaStreamSource(stream);
        this.captureSource.connect(this.splitter);
        this.updateStatus('System audio captured');
    }

    disconnectSource() {
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (e) {}
            this.sourceNode = null;
        }
        if (this.captureSource) {
            try { this.captureSource.disconnect(); } catch (e) {}
            this.captureSource = null;
        }
        if (this.captureStream) {
            this.captureStream.getTracks().forEach(t => t.stop());
            this.captureStream = null;
        }
    }

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    setCrossover(channel, type, freq, slope) {
        if (!this.initialized) return;
        const chain = this.nodes[channel];
        const filters = type === 'hpf' ? chain.hpf : chain.lpf;
        const stages = slope / 12;
        filters.forEach((f, i) => {
            f.frequency.value = i < stages ? freq : (type === 'hpf' ? 20 : 20000);
        });
    }

    setEQ(channel, bandIndex, gain) {
        if (!this.initialized) return;
        this.nodes[channel].eq[bandIndex].gain.value = gain;
    }

    setSubBoost(channel, percent) {
        if (!this.initialized) return;
        const gainDb = percent <= 0 ? -40 : 20 * Math.log10(percent / 100);
        this.nodes[channel].sub.gain.value = gainDb;
    }

    setDelay(channel, ms) {
        if (!this.initialized) return;
        this.nodes[channel].delay.delayTime.value = ms / 1000;
    }

    setPhase(channel, invert) {
        if (!this.initialized) return;
        this.nodes[channel].phase.gain.value = invert ? -1 : 1;
    }

    setChannelVolume(channel, volume, balance, muted) {
        if (!this.initialized) return;
        const vol = muted ? 0 : (volume / 100);
        const actualFactor = channel === 'L' 
            ? (balance >= 0 ? 1 : (1 + balance)) 
            : (balance <= 0 ? 1 : (1 - balance));
        this.nodes[channel].channelGain.gain.value = vol * actualFactor;
    }

    setAmpGain(channel, dB) {
        if (!this.initialized) return;
        this.nodes[channel].ampGain.gain.value = Math.pow(10, dB / 20);
    }

    setClipper(channel, enabled, drive) {
        if (!this.initialized) return;
        const curve = enabled ? this.makeClipperCurve(drive) : this.makeLinearCurve();
        this.nodes[channel].clipper.curve = curve;
    }

    setLimiter(threshold) {
        if (!this.initialized) return;
        this.nodes.L.limiter.threshold.value = threshold;
        this.nodes.R.limiter.threshold.value = threshold;
        this.masterChain.masterLimiter.threshold.value = threshold;
    }

    setMasterVolume(percent) {
        if (!this.initialized) return;
        this.masterChain.masterVolume.gain.value = percent / 100;
    }

    setMasterGain(dB) {
        if (!this.initialized) return;
        this.masterChain.masterGain.gain.value = Math.pow(10, dB / 20);
    }

    makeClipperCurve(drive) {
        const n = 4096;
        const curve = new Float32Array(n);
        const k = drive * 3;
        for (let i = 0; i < n; i++) {
            const x = (i * 2) / n - 1;
            if (k === 0) {
                curve[i] = x;
            } else {
                curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
            }
        }
        return curve;
    }

    makeLinearCurve() {
        const n = 4096;
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            curve[i] = (i * 2) / n - 1;
        }
        return curve;
    }

    getMasterAnalyser() {
        return this.initialized ? this.masterChain.masterAnalyser : null;
    }

    getChannelAnalyser(channel) {
        return this.initialized ? this.nodes[channel].analyser : null;
    }

    updateStatus(msg) {
        const el = document.getElementById('statusText');
        const footerEl = document.getElementById('footerStatusText');
        if (el) el.textContent = msg;
        if (footerEl) footerEl.textContent = msg;
    }
}

// ==================== PLAYLIST MANAGER ====================
class PlaylistManager {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.tracks = [];
        this.currentIndex = -1;
        this.shuffle = false;
        this.repeat = false;
        this.mediaElement = document.getElementById('audioPlayer');
        this.setupEvents();
    }

    setupEvents() {
        this.mediaElement.addEventListener('play', () => {
            this.audio.isPlaying = true;
            this.audio.resume();
            this.audio.updateStatus('▶️ Playing');
        });

        this.mediaElement.addEventListener('pause', () => {
            this.audio.isPlaying = false;
            this.audio.updateStatus('⏸️ Paused');
        });

        this.mediaElement.addEventListener('ended', () => {
            if (this.repeat && this.tracks.length > 0) {
                this.mediaElement.currentTime = 0;
                this.mediaElement.play();
            } else {
                this.next();
            }
        });

        this.mediaElement.addEventListener('timeupdate', () => {
            this.updateProgress();
        });

        this.mediaElement.addEventListener('loadedmetadata', () => {
            this.updateDuration();
        });
    }

    add(file) {
        const url = URL.createObjectURL(file);
        const track = {
            name: file.name,
            url: url,
            duration: 0
        };
        this.tracks.push(track);
        if (this.tracks.length === 1) {
            this.currentIndex = 0;
            this.load(0);
        }
        this.render();
        this.updateLibrary();
    }

    load(index) {
        if (index < 0 || index >= this.tracks.length) return;
        this.currentIndex = index;
        const track = this.tracks[index];
        this.mediaElement.src = track.url;
        this.mediaElement.load();
        this.updateTrackInfo(track.name);
        this.render();
    }

    play() {
        if (this.tracks.length === 0) return;
        if (this.currentIndex < 0) {
            this.currentIndex = 0;
            this.load(0);
        }
        this.audio.init();
        this.audio.connectMediaElement(this.mediaElement);
        this.audio.resume();
        this.mediaElement.play().catch(e => {
            this.audio.updateStatus('❌ Play failed');
        });
    }

    pause() {
        this.mediaElement.pause();
    }

    togglePlay() {
        if (this.mediaElement.paused) this.play();
        else this.pause();
    }

    next() {
        if (this.tracks.length === 0) return;
        let nextIndex;
        if (this.shuffle) {
            nextIndex = Math.floor(Math.random() * this.tracks.length);
        } else {
            nextIndex = (this.currentIndex + 1) % this.tracks.length;
        }
        this.load(nextIndex);
        if (!this.mediaElement.paused) this.mediaElement.play();
    }

    prev() {
        if (this.tracks.length === 0) return;
        let prevIndex;
        if (this.shuffle) {
            prevIndex = Math.floor(Math.random() * this.tracks.length);
        } else {
            prevIndex = (this.currentIndex - 1 + this.tracks.length) % this.tracks.length;
        }
        this.load(prevIndex);
        if (!this.mediaElement.paused) this.mediaElement.play();
    }

    remove(index) {
        if (index < 0 || index >= this.tracks.length) return;
        URL.revokeObjectURL(this.tracks[index].url);
        this.tracks.splice(index, 1);

        if (this.tracks.length === 0) {
            this.currentIndex = -1;
            this.mediaElement.pause();
            this.mediaElement.src = '';
            this.render();
            this.updateLibrary();
            return;
        }

        if (index === this.currentIndex) {
            this.currentIndex = Math.min(index, this.tracks.length - 1);
            this.load(this.currentIndex);
        } else if (index < this.currentIndex) {
            this.currentIndex--;
        }
        this.render();
        this.updateLibrary();
    }

    clear() {
        if (!confirm('Hapus semua lagu dari playlist?')) return;
        this.tracks.forEach(t => URL.revokeObjectURL(t.url));
        this.tracks = [];
        this.currentIndex = -1;
        this.mediaElement.pause();
        this.mediaElement.src = '';
        this.render();
        this.updateLibrary();
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        return this.shuffle;
    }

    toggleRepeat() {
        this.repeat = !this.repeat;
        return this.repeat;
    }

    seek(percent) {
        if (!this.mediaElement.duration) return;
        this.mediaElement.currentTime = (percent / 100) * this.mediaElement.duration;
    }

    updateProgress() {
        const current = this.mediaElement.currentTime;
        const duration = this.mediaElement.duration || 0;
        const percent = duration > 0 ? (current / duration) * 100 : 0;

        const fill = document.getElementById('progressFill');
        const handle = document.getElementById('progressHandle');
        if (fill) fill.style.width = percent + '%';
        if (handle) handle.style.left = percent + '%';
        
        const currentTimeEl = document.getElementById('currentTime');
        if (currentTimeEl) currentTimeEl.textContent = this.formatTime(current);
    }

    updateDuration() {
        const duration = this.mediaElement.duration || 0;
        const totalTimeEl = document.getElementById('totalTime');
        if (totalTimeEl) totalTimeEl.textContent = this.formatTime(duration);
        if (this.currentIndex >= 0) {
            this.tracks[this.currentIndex].duration = duration;
            this.render();
        }
    }

    formatTime(seconds) {
        if (!isFinite(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    updateTrackInfo(name) {
        const titleEl = document.getElementById('trackTitle');
        const artistEl = document.getElementById('trackArtist');
        if (titleEl) titleEl.textContent = name.replace(/\.[^/.]+$/, '');
        if (artistEl) artistEl.textContent = 'File Lokal';
    }

    render() {
        const el = document.getElementById('playlist');
        const countEl = document.getElementById('playlistCount');
        if (countEl) countEl.textContent = this.tracks.length;

        if (this.tracks.length === 0) {
            el.innerHTML = `<div class="library-empty text-center py-8 text-gray-500 text-sm">
                <i class="fas fa-music-slash text-3xl mb-2 opacity-30"></i>
                <p>No tracks. Add audio files to begin.</p>
            </div>`;
            return;
        }

        el.innerHTML = this.tracks.map((t, i) => {
            const isActive = i === this.currentIndex;
            const duration = t.duration ? this.formatTime(t.duration) : '';
            return `
                <div class="playlist-item ${isActive ? 'active' : ''}" data-index="${i}">
                    <span class="track-num">${i + 1}</span>
                    <span class="track-name">${t.name.replace(/\.[^/.]+$/, '')}</span>
                    <span class="track-duration">${duration}</span>
                    <button class="remove-btn" data-index="${i}">✕</button>
                </div>
            `;
        }).join('');
    }

    updateLibrary() {
        const el = document.getElementById('libraryGrid');
        if (!el) return;
        if (this.tracks.length === 0) {
            el.innerHTML = `<div class="library-empty col-span-full text-center py-12 text-gray-500 text-sm">
                <i class="fas fa-folder-open text-4xl mb-3 opacity-30"></i>
                <p>No tracks in library. Add files from Player tab.</p>
            </div>`;
            return;
        }
        el.innerHTML = this.tracks.map((t, i) => `
            <div class="playlist-item" data-index="${i}" style="flex-direction:column;align-items:center;padding:12px;">
                <div style="font-size:2rem;margin-bottom:6px;">🎵</div>
                <span class="track-name" style="font-size:0.7rem;text-align:center;">${t.name.replace(/\.[^/.]+$/, '')}</span>
            </div>
        `).join('');
    }
}

// ==================== VISUALIZER ====================
class Visualizer {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.mode = 'bars';
        this.animationId = null;
        this.setupCanvases();
    }

    setupCanvases() {
        this.spectrumCanvas = document.getElementById('spectrum');
        this.spectrumCtx = this.spectrumCanvas ? this.spectrumCanvas.getContext('2d') : null;
        this.eqCurveCanvas = document.getElementById('eqCurve');
        this.eqCurveCtx = this.eqCurveCanvas ? this.eqCurveCanvas.getContext('2d') : null;

        this.resizeCanvases();
        window.addEventListener('resize', () => this.resizeCanvases());
    }

    resizeCanvases() {
        const dpr = window.devicePixelRatio || 1;

        [this.spectrumCanvas, this.eqCurveCanvas].forEach(canvas => {
            if (!canvas) return;
            const rect = canvas.parentElement.getBoundingClientRect();
            canvas.width = (rect.width || canvas.offsetWidth) * dpr;
            canvas.height = (rect.height || canvas.offsetHeight) * dpr;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.scale(dpr, dpr);
        });
    }

    start() {
        if (this.animationId) return;
        this.draw();
    }

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    draw() {
        this.animationId = requestAnimationFrame(() => this.draw());
        if (!this.audio.initialized || !this.audio.isPlaying) {
            this.drawIdle();
            return;
        }

        this.drawSpectrum();
        this.updateBandMeters();
        this.updateVUMeters();
    }

    drawIdle() {
        if (!this.spectrumCtx || !this.spectrumCanvas) return;
        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.offsetWidth;
        const height = this.spectrumCanvas.offsetHeight;
        if (!width || !height) return;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = 'rgba(0, 255, 136, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
    }

    drawSpectrum() {
        const analyser = this.audio.getMasterAnalyser();
        if (!analyser || !this.spectrumCtx) return;

        const ctx = this.spectrumCtx;
        const width = this.spectrumCanvas.offsetWidth;
        const height = this.spectrumCanvas.offsetHeight;
        if (!width || !height) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        const sampleRate = this.audio.sampleRate;
        const freqPerBin = sampleRate / analyser.fftSize;

        if (this.mode === 'bars') {
            this.drawBars(ctx, width, height, dataArray, bufferLength, freqPerBin);
        } else if (this.mode === 'line') {
            this.drawLine(ctx, width, height, dataArray, bufferLength);
        } else if (this.mode === 'circles') {
            this.drawCircles(ctx, width, height, dataArray, bufferLength, freqPerBin);
        } else if (this.mode === 'wave') {
            this.drawWaveform(ctx, width, height, analyser, bufferLength);
        }
    }

    drawBars(ctx, width, height, dataArray, bufferLength, freqPerBin) {
        const barCount = 64;
        const barsPerGroup = Math.floor(bufferLength / barCount);
        const barWidth = width / barCount;

        for (let i = 0; i < barCount; i++) {
            let sum = 0;
            for (let j = 0; j < barsPerGroup; j++) {
                sum += dataArray[i * barsPerGroup + j];
            }
            const avg = sum / barsPerGroup;
            const barHeight = (avg / 255) * height;
            const freq = (i * barsPerGroup + barsPerGroup / 2) * freqPerBin;

            let color;
            if (freq < 60) color = '#ff3355';
            else if (freq < 250) color = '#ff6b35';
            else if (freq < 4000) color = '#00ff88';
            else if (freq < 8000) color = '#00d2d3';
            else color = '#b366ff';

            const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
            gradient.addColorStop(0, color);
            gradient.addColorStop(1, color + '20');
            ctx.fillStyle = gradient;
            ctx.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, barHeight);

            ctx.fillStyle = color + 'AA';
            ctx.fillRect(i * barWidth + 1, height - barHeight - 2, barWidth - 2, 2);
        }
    }

    drawLine(ctx, width, height, dataArray, bufferLength) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00ff88';
        ctx.beginPath();
        const step = Math.floor(bufferLength / 256);
        for (let i = 0; i < 256; i++) {
            const x = (i / 256) * width;
            const y = height - (dataArray[i * step] / 255) * height;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0, 255, 136, 0.08)';
        ctx.fill();
    }

    drawCircles(ctx, width, height, dataArray, bufferLength, freqPerBin) {
        const centerX = width / 2;
        const centerY = height / 2;
        const maxRadius = Math.min(width, height) / 2 - 10;
        const step = Math.floor(bufferLength / 64);

        for (let i = 0; i < 64; i++) {
            const radius = ((64 - i) / 64) * maxRadius * (dataArray[i * step] / 255);
            const angle = (i / 64) * Math.PI * 2;
            const freq = (i * step) * freqPerBin;
            let color;
            if (freq < 250) color = '#ff6b35';
            else if (freq < 4000) color = '#00ff88';
            else color = '#00d2d3';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(centerX, centerY, Math.max(0, radius), angle, angle + 0.15);
            ctx.stroke();
        }
    }

    drawWaveform(ctx, width, height, analyser, bufferLength) {
        const timeData = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(timeData);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00ff88';
        ctx.beginPath();
        const sliceWidth = width / bufferLength;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const v = timeData[i] / 128.0;
            const y = (v * height) / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.stroke();
    }

    updateBandMeters() {
        const analyser = this.audio.getMasterAnalyser();
        if (!analyser) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        const sampleRate = this.audio.sampleRate;
        const freqPerBin = sampleRate / analyser.fftSize;

        const bands = { sub: [0, 0], bass: [0, 0], mid: [0, 0], treble: [0, 0], tweeter: [0, 0] };

        for (let i = 0; i < bufferLength; i++) {
            const freq = i * freqPerBin;
            if (freq > 20000) break;
            const v = dataArray[i];
            if (freq < 60) { bands.sub[0] += v; bands.sub[1]++; }
            else if (freq < 250) { bands.bass[0] += v; bands.bass[1]++; }
            else if (freq < 4000) { bands.mid[0] += v; bands.mid[1]++; }
            else if (freq < 8000) { bands.treble[0] += v; bands.treble[1]++; }
            else { bands.tweeter[0] += v; bands.tweeter[1]++; }
        }

        Object.keys(bands).forEach(band => {
            if (bands[band][1] === 0) return;
            const avg = bands[band][0] / bands[band][1];
            const capBand = band.charAt(0).toUpperCase() + band.slice(1);
            this.updateVU('viz' + capBand, avg, 10);
            const valEl = document.getElementById('viz' + capBand + 'Val');
            if (valEl) valEl.textContent = Math.round(avg);
        });
    }

    updateVUMeters() {
        ['L', 'R'].forEach(ch => {
            const analyser = this.audio.getChannelAnalyser(ch);
            if (!analyser) return;
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(data);
            const avg = data.reduce((a, b) => a + b, 0) / data.length;
            this.updateVU('vu' + ch, avg, 12);

            const powerEl = document.getElementById('power' + ch);
            const powerValEl = document.getElementById('power' + ch + 'Val');
            if (powerEl) powerEl.style.width = Math.min(100, (avg / 255) * 150) + '%';
            if (powerValEl) powerValEl.textContent = Math.round(Math.min(100, (avg / 255) * 150)) + '%';
        });
    }

    updateVU(id, level, segments) {
        const el = document.getElementById(id);
        if (!el) return;
        const segs = el.children;
        if (!segs.length) return;
        const active = Math.floor((level / 255) * segs.length);
        for (let i = 0; i < segs.length; i++) {
            segs[i].className = 'vu-segment';
            if (i >= segs.length - active) {
                const fromRight = segs.length - 1 - i;
                if (fromRight < 2) segs[i].classList.add('active-red');
                else if (fromRight < 4) segs[i].classList.add('active-yellow');
                else segs[i].classList.add('active-green');
            }
        }
    }

    buildVUMeters() {
        ['vuL', 'vuR'].forEach(id => this.buildVU(id, 12));
        ['vizSub', 'vizBass', 'vizMid', 'vizTreble', 'vizTweeter'].forEach(id => this.buildVU(id, 10));
    }

    buildVU(id, segments) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        for (let i = 0; i < segments; i++) {
            const seg = document.createElement('div');
            seg.className = 'vu-segment';
            el.appendChild(seg);
        }
    }

    drawEQCurve() {
        if (!this.eqCurveCtx || !this.eqCurveCanvas) return;
        const ctx = this.eqCurveCtx;
        const canvas = this.eqCurveCanvas;
        const width = canvas.offsetWidth;
        const height = canvas.offsetHeight;
        if (!width || !height) return;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        // Grid
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (i / 4) * height;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        const freqs = [];
        for (let i = 0; i < width; i++) {
            const f = 20 * Math.pow(1000, i / width);
            freqs.push(f);
        }

        const gains = new Array(width).fill(0);

        CONFIG.EQ_FREQS.forEach((centerFreq, idx) => {
            const slider = document.getElementById(`eq-L-${idx}`);
            if (!slider) return;
            const gain = parseFloat(slider.value);
            if (gain === 0) return;

            const Q = CONFIG.EQ_Q;
            freqs.forEach((f, i) => {
                const w0 = 2 * Math.PI * f;
                const w = 2 * Math.PI * centerFreq;
                const bw = w / (2 * Q);
                const response = 1 / Math.sqrt(1 + Math.pow((w0 - w) / bw, 2));
                const db = gain * response;
                gains[i] += db;
            });
        });

        // Draw curve
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < width; i++) {
            const y = height / 2 - (gains[i] / 12) * (height / 2);
            if (i === 0) ctx.moveTo(i, y);
            else ctx.lineTo(i, y);
        }
        ctx.stroke();

        ctx.lineTo(width, height / 2);
        ctx.lineTo(0, height / 2);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0, 255, 136, 0.1)';
        ctx.fill();

        // 0dB line
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
    }

    setMode(mode) {
        this.mode = mode;
    }
}

// ==================== EQ MANAGER ====================
class EQManager {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.buildEQ();
        this.buildPresets();
    }

    buildEQ() {
        ['L', 'R'].forEach(ch => {
            const container = document.getElementById('eq' + ch);
            if (!container) return;
            container.innerHTML = CONFIG.EQ_FREQS.map((freq, i) => {
                const label = freq >= 1000 ? (freq / 1000) + 'k' : freq;
                return `
                    <div class="eq-band">
                        <div class="gain-val" id="eq-${ch}-${i}-val">0</div>
                        <input type="range" id="eq-${ch}-${i}" min="-12" max="12" step="0.5" value="0">
                        <div class="freq">${label}</div>
                    </div>
                `;
            }).join('');

            container.querySelectorAll('input').forEach((sl, i) => {
                sl.addEventListener('input', () => {
                    const v = parseFloat(sl.value);
                    const valEl = document.getElementById(`eq-${ch}-${i}-val`);
                    if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v;
                    this.audio.setEQ(ch, i, v);
                    if (app && app.visualizer) app.visualizer.drawEQCurve();
                });
            });
        });
    }

    buildPresets() {
        const container = document.getElementById('presetsGrid');
        if (!container) return;
        container.innerHTML = Object.keys(CONFIG.PRESETS).map(name => `
            <button class="preset-btn" data-preset="${name}">${name}</button>
        `).join('');

        container.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.preset;
                const vals = CONFIG.PRESETS[name];
                container.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                ['L', 'R'].forEach(ch => {
                    vals.forEach((v, i) => {
                        const sl = document.getElementById(`eq-${ch}-${i}`);
                        if (sl) {
                            sl.value = v;
                            const valEl = document.getElementById(`eq-${ch}-${i}-val`);
                            if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v;
                            this.audio.setEQ(ch, i, v);
                        }
                    });
                });
                if (app && app.visualizer) app.visualizer.drawEQCurve();
            });
        });
    }

    reset() {
        ['L', 'R'].forEach(ch => {
            for (let i = 0; i < 15; i++) {
                const sl = document.getElementById(`eq-${ch}-${i}`);
                if (sl) {
                    sl.value = 0;
                    const valEl = document.getElementById(`eq-${ch}-${i}-val`);
                    if (valEl) valEl.textContent = '0';
                    this.audio.setEQ(ch, i, 0);
                }
            }
        });
        document.querySelectorAll('.preset-btn').forEach(p => p.classList.remove('active'));
        if (app && app.visualizer) app.visualizer.drawEQCurve();
    }

    invert() {
        ['L', 'R'].forEach(ch => {
            for (let i = 0; i < 15; i++) {
                const sl = document.getElementById(`eq-${ch}-${i}`);
                if (sl) {
                    const newVal = -parseFloat(sl.value);
                    sl.value = newVal;
                    const valEl = document.getElementById(`eq-${ch}-${i}-val`);
                    if (valEl) valEl.textContent = (newVal > 0 ? '+' : '') + newVal;
                    this.audio.setEQ(ch, i, newVal);
                }
            }
        });
        if (app && app.visualizer) app.visualizer.drawEQCurve();
    }

    copyLtoR() {
        for (let i = 0; i < 15; i++) {
            const val = document.getElementById(`eq-L-${i}`)?.value || 0;
            const sl = document.getElementById(`eq-R-${i}`);
            if (sl) {
                sl.value = val;
                const valEl = document.getElementById(`eq-R-${i}-val`);
                if (valEl) valEl.textContent = (parseFloat(val) > 0 ? '+' : '') + val;
                this.audio.setEQ('R', i, parseFloat(val));
            }
        }
        if (app && app.visualizer) app.visualizer.drawEQCurve();
    }

    copyRtoL() {
        for (let i = 0; i < 15; i++) {
            const val = document.getElementById(`eq-R-${i}`)?.value || 0;
            const sl = document.getElementById(`eq-L-${i}`);
            if (sl) {
                sl.value = val;
                const valEl = document.getElementById(`eq-L-${i}-val`);
                if (valEl) valEl.textContent = (parseFloat(val) > 0 ? '+' : '') + val;
                this.audio.setEQ('L', i, parseFloat(val));
            }
        }
        if (app && app.visualizer) app.visualizer.drawEQCurve();
    }
}

// ==================== OUTPUT MANAGER ====================
class OutputManager {
    constructor() {
        this.audioElement = document.getElementById('audioPlayer');
        this.currentSink = 'default';
    }

    async refresh() {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                if (app && app.audio) app.audio.updateStatus('Device enumeration not supported');
                return;
            }

            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (e) { /* ignore */ }

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
            const list = document.getElementById('outputList');

            if (!audioOutputs.length) {
                list.innerHTML = `
                    <div class="output-item active" data-sink="default">
                        <div class="output-icon">🔊</div>
                        <div class="output-info">
                            <div class="output-name">Speaker Default</div>
                            <div class="output-desc">Default device</div>
                        </div>
                    </div>
                `;
            } else {
                list.innerHTML = audioOutputs.map((d, i) => {
                    const label = d.label || ('Device ' + (i + 1));
                    const lower = label.toLowerCase();
                    let icon = '🔊';
                    if (lower.includes('bluetooth') || lower.includes('bt')) icon = '🎧';
                    else if (lower.includes('headphone') || lower.includes('ear')) icon = '🎧';
                    else if (lower.includes('usb') || lower.includes('dac')) icon = '🔌';
                    else if (lower.includes('hdmi')) icon = '📺';

                    return `
                        <div class="output-item ${d.deviceId === this.currentSink ? 'active' : ''}" data-sink="${d.deviceId || 'default'}">
                            <div class="output-icon">${icon}</div>
                            <div class="output-info">
                                <div class="output-name">${label}</div>
                                <div class="output-desc">${d.deviceId ? 'ID: ' + d.deviceId.slice(0, 20) + '...' : 'Default device'}</div>
                            </div>
                        </div>
                    `;
                }).join('');
            }

            list.querySelectorAll('.output-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const sinkId = item.dataset.sink;
                    if (typeof this.audioElement.setSinkId === 'function') {
                        try {
                            await this.audioElement.setSinkId(sinkId);
                            this.currentSink = sinkId;
                            list.querySelectorAll('.output-item').forEach(o => o.classList.remove('active'));
                            item.classList.add('active');
                            if (app && app.audio) app.audio.updateStatus('Output: ' + item.querySelector('.output-name').textContent);
                        } catch (e) {
                            if (app && app.audio) app.audio.updateStatus('Failed: ' + e.message);
                        }
                    } else {
                        if (app && app.audio) app.audio.updateStatus('setSinkId not supported');
                    }
                });
            });
        } catch (e) {
            if (app && app.audio) app.audio.updateStatus('Error: ' + e.message);
        }
    }
}

// ==================== SETTINGS MANAGER ====================
class SettingsManager {
    constructor() {
        this.keys = [
            'volL', 'volR', 'balance',
            'hpfL', 'lpfL', 'hpfR', 'lpfR',
            'hpfLSlope', 'lpfLSlope', 'hpfRSlope', 'lpfRSlope',
            'delayL', 'delayR', 'phaseL', 'phaseR',
            'subL', 'subR', 'limiter',
            'gainL', 'gainR',
            'clipL', 'clipR', 'clipLDrive', 'clipRDrive',
            'masterVol', 'masterGain'
        ];
    }

    getAll() {
        const data = {};
        this.keys.forEach(key => {
            const el = document.getElementById(key);
            if (el) data[key] = el.type === 'checkbox' ? el.checked : el.value;
        });
        data.eqL = CONFIG.EQ_FREQS.map((_, i) => document.getElementById(`eq-L-${i}`)?.value || 0);
        data.eqR = CONFIG.EQ_FREQS.map((_, i) => document.getElementById(`eq-R-${i}`)?.value || 0);
        return data;
    }

    apply(data) {
        if (!data) return;
        this.keys.forEach(key => {
            const el = document.getElementById(key);
            if (el && data[key] !== undefined) {
                if (el.type === 'checkbox') el.checked = data[key];
                else el.value = data[key];
                el.dispatchEvent(new Event('input'));
                if (el.type === 'checkbox') el.dispatchEvent(new Event('change'));
            }
        });
        if (data.eqL) {
            data.eqL.forEach((v, i) => {
                const sl = document.getElementById(`eq-L-${i}`);
                if (sl) { sl.value = v; sl.dispatchEvent(new Event('input')); }
            });
        }
        if (data.eqR) {
            data.eqR.forEach((v, i) => {
                const sl = document.getElementById(`eq-R-${i}`);
                if (sl) { sl.value = v; sl.dispatchEvent(new Event('input')); }
            });
        }
    }

    save() {
        try {
            localStorage.setItem('powerampSettings', JSON.stringify(this.getAll()));
            if (app && app.audio) app.audio.updateStatus('💾 Settings saved');
        } catch (e) { 
            if (app && app.audio) app.audio.updateStatus('❌ Save failed'); 
        }
    }

    load() {
        try {
            const data = localStorage.getItem('powerampSettings');
            if (data) {
                this.apply(JSON.parse(data));
                if (app && app.audio) app.audio.updateStatus('📂 Settings loaded');
            } else {
                if (app && app.audio) app.audio.updateStatus('⚠️ No saved settings');
            }
        } catch (e) { 
            if (app && app.audio) app.audio.updateStatus('❌ Load failed'); 
        }
    }

    reset() {
        if (confirm('Reset semua pengaturan ke default?')) {
            localStorage.removeItem('powerampSettings');
            location.reload();
        }
    }

    export() {
        const data = JSON.stringify(this.getAll(), null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'poweramp-settings.json';
        a.click();
        URL.revokeObjectURL(url);
        if (app && app.audio) app.audio.updateStatus('📤 Settings exported');
    }

    import() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = evt => {
                try {
                    const data = JSON.parse(evt.target.result);
                    this.apply(data);
                    if (app && app.audio) app.audio.updateStatus('📥 Settings imported');
                } catch (err) { 
                    if (app && app.audio) app.audio.updateStatus('❌ Invalid file'); 
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
}

// ==================== INPUT MANAGER ====================
class InputManager {
    constructor(audioEngine, playlist) {
        this.audio = audioEngine;
        this.playlist = playlist;
        this.currentSource = 'local';
        this.youtubePlayer = null;
        this.spotifyPlayer = null;
        this.setupListeners();
    }

    setupListeners() {
        // Source buttons
        document.querySelectorAll('.source-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const source = btn.dataset.source;
                this.switchSource(source);
            });
        });

        // File input
        const fileInput = document.getElementById('fileInput');
        const dropZone = document.getElementById('dropZone');

        if (fileInput) {
            fileInput.addEventListener('change', e => {
                Array.from(e.target.files).forEach(f => this.playlist.add(f));
                e.target.value = '';
            });
        }

        if (dropZone) {
            dropZone.addEventListener('dragover', e => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });

            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });

            dropZone.addEventListener('drop', e => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                Array.from(e.dataTransfer.files).forEach(f => {
                    if (f.type.startsWith('audio/')) this.playlist.add(f);
                });
            });
        }

        // YouTube
        const btnYoutubeLoad = document.getElementById('btnYoutubeLoad');
        if (btnYoutubeLoad) btnYoutubeLoad.addEventListener('click', () => this.loadYoutube());

        // System Capture
        const btnStartCapture = document.getElementById('btnStartCapture');
        const btnStopCapture = document.getElementById('btnStopCapture');
        const btnCaptureYoutube = document.getElementById('btnCaptureYoutube');

        if (btnStartCapture) btnStartCapture.addEventListener('click', () => this.startCapture());
        if (btnStopCapture) btnStopCapture.addEventListener('click', () => this.stopCapture());
        if (btnCaptureYoutube) btnCaptureYoutube.addEventListener('click', () => this.startCapture());

        // Spotify
        const btnSpotifyLogin = document.getElementById('btnSpotifyLogin');
        const btnSpotifyPlay = document.getElementById('btnSpotifyPlay');
        const btnSpotifyPause = document.getElementById('btnSpotifyPause');
        const btnSpotifyNext = document.getElementById('btnSpotifyNext');

        if (btnSpotifyLogin) btnSpotifyLogin.addEventListener('click', () => this.loginSpotify());
        if (btnSpotifyPlay) btnSpotifyPlay.addEventListener('click', () => this.spotifyPlay());
        if (btnSpotifyPause) btnSpotifyPause.addEventListener('click', () => this.spotifyPause());
        if (btnSpotifyNext) btnSpotifyNext.addEventListener('click', () => this.spotifyNext());
    }

    switchSource(source) {
        this.currentSource = source;
        document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.source-btn[data-source="${source}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        document.querySelectorAll('.source-panel').forEach(p => {
            p.classList.remove('active');
            p.classList.add('hidden');
        });
        const panel = document.getElementById('panel-' + source);
        if (panel) {
            panel.classList.add('active');
            panel.classList.remove('hidden');
        }
        const badge = document.getElementById('sourceBadge');
        if (badge) badge.textContent = source.toUpperCase();
    }

    loadYoutube() {
        const url = document.getElementById('youtubeUrl')?.value.trim();
        if (!url) return;
        const videoId = this.extractYoutubeId(url);
        if (!videoId) {
            alert('URL YouTube tidak valid');
            return;
        }

        if (!this.youtubePlayer) {
            this.createYoutubePlayer(videoId);
        } else {
            this.youtubePlayer.loadVideoById(videoId);
        }
    }

    extractYoutubeId(url) {
        const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
        const match = url.match(regExp);
        return (match && match[2].length === 11) ? match[2] : null;
    }

    createYoutubePlayer(videoId) {
        if (!window.YT || !window.YT.Player) {
            alert('YouTube API belum siap. Coba lagi dalam beberapa detik.');
            return;
        }
        this.youtubePlayer = new YT.Player('youtubePlayer', {
            height: '100%',
            width: '100%',
            videoId: videoId,
            playerVars: { playsinline: 1 }
        });
    }

    async startCapture() {
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
            this.audio.connectStream(stream);
            const captureStatus = document.getElementById('captureStatus');
            if (captureStatus) captureStatus.classList.remove('hidden');
            const startBtn = document.getElementById('btnStartCapture');
            if (startBtn && startBtn.parentElement) startBtn.parentElement.classList.add('hidden');
        } catch (e) {
            alert('Gagal menangkap audio: ' + e.message);
        }
    }

    stopCapture() {
        this.audio.disconnectSource();
        const captureStatus = document.getElementById('captureStatus');
        if (captureStatus) captureStatus.classList.add('hidden');
        const startBtn = document.getElementById('btnStartCapture');
        if (startBtn && startBtn.parentElement) startBtn.parentElement.classList.remove('hidden');
    }

    loginSpotify() {
        const clientId = document.getElementById('spotifyClientId')?.value.trim() || 'YOUR_CLIENT_ID';
        const redirectUri = window.location.origin + window.location.pathname;
        const scope = 'streaming user-read-email user-read-private';
        const url = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
        window.location.href = url;
    }

    initSpotifyFromHash() {
        const hash = window.location.hash;
        if (hash.includes('access_token')) {
            const token = new URLSearchParams(hash.slice(1)).get('access_token');
            if (token) {
                window.location.hash = '';
                this.setupSpotifyPlayer(token);
            }
        }
    }

    setupSpotifyPlayer(token) {
        if (!window.Spotify) {
            setTimeout(() => this.setupSpotifyPlayer(token), 1000);
            return;
        }
        const player = new Spotify.Player({
            name: 'Poweramp Web',
            getOAuthToken: cb => cb(token),
            volume: 1.0
        });

        player.addListener('ready', ({ device_id }) => {
            console.log('Spotify Ready:', device_id);
            const spotifyAuth = document.getElementById('spotifyAuth');
            const spotifyPlayerContainer = document.getElementById('spotifyPlayerContainer');
            if (spotifyAuth) spotifyAuth.classList.add('hidden');
            if (spotifyPlayerContainer) spotifyPlayerContainer.classList.remove('hidden');
        });

        player.addListener('not_ready', ({ device_id }) => {
            console.log('Spotify Offline:', device_id);
        });

        player.connect();
        this.spotifyPlayer = player;
    }

    spotifyPlay() { if (this.spotifyPlayer) this.spotifyPlayer.resume(); }
    spotifyPause() { if (this.spotifyPlayer) this.spotifyPlayer.pause(); }
    spotifyNext() { if (this.spotifyPlayer) this.spotifyPlayer.nextTrack(); }
}

// ==================== MAIN APP ====================
class App {
    constructor() {
        this.audio = new AudioEngine();
        this.playlist = new PlaylistManager(this.audio);
        this.visualizer = new Visualizer(this.audio);
        this.eq = new EQManager(this.audio);
        this.output = new OutputManager();
        this.settings = new SettingsManager();
        this.input = new InputManager(this.audio, this.playlist);
        this.muted = { L: false, R: false };
    }

    init() {
        this.setupNavigation();
        this.setupControls();
        this.setupKeyboard();
        this.visualizer.buildVUMeters();
        this.visualizer.drawEQCurve();
        this.output.refresh();
        this.input.initSpotifyFromHash();

        // Load saved settings
        setTimeout(() => {
            const saved = localStorage.getItem('powerampSettings');
            if (saved) {
                try { this.settings.apply(JSON.parse(saved)); } catch (e) {}
            }
        }, 500);

        this.visualizer.start();

        // Latency updater
        setInterval(() => {
            if (this.audio.initialized && this.audio.ctx) {
                const latency = Math.round((this.audio.ctx.baseLatency || 0) * 1000);
                const latencyEl = document.getElementById('latencyInfo');
                if (latencyEl) latencyEl.textContent = 'Latency: ' + latency + 'ms';
            }
        }, 1000);
    }

    setupNavigation() {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.view;
                document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.view').forEach(v => {
                    v.classList.remove('active');
                    v.classList.add('hidden');
                });
                btn.classList.add('active');
                const viewEl = document.getElementById('view-' + view);
                if (viewEl) {
                    viewEl.classList.add('active');
                    viewEl.classList.remove('hidden');
                }
                if (view === 'eq') this.visualizer.drawEQCurve();
            });
        });
    }

    setupControls() {
        // Transport
        const btnPlay = document.getElementById('btnPlay');
        const btnPrev = document.getElementById('btnPrev');
        const btnNext = document.getElementById('btnNext');
        const btnShuffle = document.getElementById('btnShuffle');
        const btnRepeat = document.getElementById('btnRepeat');

        if (btnPlay) btnPlay.addEventListener('click', () => this.playlist.togglePlay());
        if (btnPrev) btnPrev.addEventListener('click', () => this.playlist.prev());
        if (btnNext) btnNext.addEventListener('click', () => this.playlist.next());
        if (btnShuffle) btnShuffle.addEventListener('click', () => {
            const active = this.playlist.toggleShuffle();
            btnShuffle.classList.toggle('active', active);
        });
        if (btnRepeat) btnRepeat.addEventListener('click', () => {
            const active = this.playlist.toggleRepeat();
            btnRepeat.classList.toggle('active', active);
        });

        // Progress bar
        const progressContainer = document.getElementById('progressContainer');
        if (progressContainer) {
            let isSeeking = false;
            progressContainer.addEventListener('click', e => {
                const rect = progressContainer.getBoundingClientRect();
                const percent = ((e.clientX - rect.left) / rect.width) * 100;
                this.playlist.seek(percent);
            });
            progressContainer.addEventListener('mousedown', () => isSeeking = true);
            document.addEventListener('mouseup', () => isSeeking = false);
            progressContainer.addEventListener('mousemove', e => {
                if (!isSeeking) return;
                const rect = progressContainer.getBoundingClientRect();
                const percent = ((e.clientX - rect.left) / rect.width) * 100;
                this.playlist.seek(percent);
            });
        }

        // Playlist
        const playlistEl = document.getElementById('playlist');
        if (playlistEl) {
            playlistEl.addEventListener('click', e => {
                const item = e.target.closest('.playlist-item');
                if (!item) return;
                const index = parseInt(item.dataset.index);
                if (e.target.classList.contains('remove-btn')) {
                    e.stopPropagation();
                    this.playlist.remove(index);
                } else {
                    this.playlist.load(index);
                    this.playlist.play();
                }
            });
        }

        const btnClearPlaylist = document.getElementById('btnClearPlaylist');
        if (btnClearPlaylist) btnClearPlaylist.addEventListener('click', () => this.playlist.clear());

        // Volume
        ['L', 'R'].forEach(ch => {
            const slider = document.getElementById('vol' + ch);
            const valEl = document.getElementById('vol' + ch + 'Val');
            const muteBtn = document.getElementById('mute' + ch);

            if (slider) {
                slider.addEventListener('input', () => {
                    if (valEl) valEl.textContent = slider.value + '%';
                    this.updateChannelGains();
                });
            }

            if (muteBtn) {
                muteBtn.addEventListener('click', () => {
                    this.muted[ch] = !this.muted[ch];
                    muteBtn.classList.toggle('active', this.muted[ch]);
                    muteBtn.textContent = this.muted[ch] ? 'Unmute' : 'Mute';
                    this.updateChannelGains();
                });
            }
        });

        // Balance
        const balance = document.getElementById('balance');
        if (balance) {
            balance.addEventListener('input', () => {
                const b = parseFloat(balance.value);
                let label = 'Center';
                if (b < -10) label = 'L ' + Math.abs(b) + '%';
                else if (b > 10) label = 'R ' + b + '%';
                const balanceVal = document.getElementById('balanceVal');
                if (balanceVal) balanceVal.textContent = label;
                this.updateChannelGains();
            });
        }

        // Crossover
        ['L', 'R'].forEach(ch => {
            ['hpf', 'lpf'].forEach(type => {
                const slider = document.getElementById(type + ch);
                const valEl = document.getElementById(type + ch + 'Val');
                const slopeEl = document.getElementById(type + ch + 'Slope');

                const update = () => {
                    if (!slider) return;
                    const v = parseFloat(slider.value);
                    if (valEl) valEl.textContent = v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : v + ' Hz';
                    const slope = slopeEl ? parseInt(slopeEl.value) : 12;
                    this.audio.setCrossover(ch, type, v, slope);
                };

                if (slider) slider.addEventListener('input', update);
                if (slopeEl) slopeEl.addEventListener('change', update);
            });
        });

        // Delay
        ['L', 'R'].forEach(ch => {
            const slider = document.getElementById('delay' + ch);
            if (slider) {
                slider.addEventListener('input', () => {
                    const valEl = document.getElementById('delay' + ch + 'Val');
                    if (valEl) valEl.textContent = slider.value + ' ms';
                    this.audio.setDelay(ch, parseFloat(slider.value));
                });
            }
        });

        // Phase
        ['L', 'R'].forEach(ch => {
            const phaseEl = document.getElementById('phase' + ch);
            if (phaseEl) {
                phaseEl.addEventListener('change', e => {
                    this.audio.setPhase(ch, e.target.checked);
                });
            }
        });

        // Sub
        ['L', 'R'].forEach(ch => {
            const slider = document.getElementById('sub' + ch);
            if (slider) {
                slider.addEventListener('input', () => {
                    const valEl = document.getElementById('sub' + ch + 'Val');
                    if (valEl) valEl.textContent = slider.value + '%';
                    this.audio.setSubBoost(ch, parseFloat(slider.value));
                });
            }
        });

        // Limiter
        const limiter = document.getElementById('limiter');
        if (limiter) {
            limiter.addEventListener('input', () => {
                const valEl = document.getElementById('limiterVal');
                if (valEl) valEl.textContent = limiter.value + ' dB';
                this.audio.setLimiter(parseFloat(limiter.value));
            });
        }

        // Amp Gain
        ['L', 'R'].forEach(ch => {
            const slider = document.getElementById('gain' + ch);
            if (slider) {
                slider.addEventListener('input', () => {
                    const v = parseFloat(slider.value);
                    const valEl = document.getElementById('gain' + ch + 'Val');
                    if (valEl) valEl.textContent = (v >= 0 ? '+' : '') + v + ' dB';
                    this.audio.setAmpGain(ch, v);
                });
            }
        });

        // Clipper
        ['L', 'R'].forEach(ch => {
            const check = document.getElementById('clip' + ch);
            const drive = document.getElementById('clip' + ch + 'Drive');
            const update = () => {
                const enabled = check ? check.checked : false;
                const driveVal = drive ? parseFloat(drive.value) : 30;
                const driveValEl = document.getElementById('clip' + ch + 'DriveVal');
                if (driveValEl) driveValEl.textContent = driveVal + '%';
                this.audio.setClipper(ch, enabled, driveVal);
            };
            if (check) check.addEventListener('change', update);
            if (drive) drive.addEventListener('input', update);
        });

        // Master
        const masterVol = document.getElementById('masterVol');
        if (masterVol) {
            masterVol.addEventListener('input', () => {
                const valEl = document.getElementById('masterVolVal');
                if (valEl) valEl.textContent = masterVol.value + '%';
                this.audio.setMasterVolume(parseFloat(masterVol.value));
            });
        }

        const masterGain = document.getElementById('masterGain');
        if (masterGain) {
            masterGain.addEventListener('input', () => {
                const v = parseFloat(masterGain.value);
                const valEl = document.getElementById('masterGainVal');
                if (valEl) valEl.textContent = (v >= 0 ? '+' : '') + v + ' dB';
                this.audio.setMasterGain(v);
            });
        }

        // Viz modes
        document.querySelectorAll('.viz-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.viz-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.visualizer.setMode(btn.dataset.viz);
            });
        });

        // EQ actions
        const btnEqReset = document.getElementById('btnEqReset');
        const btnEqInvert = document.getElementById('btnEqInvert');
        const btnEqCopyLtoR = document.getElementById('btnEqCopyLtoR');
        const btnEqCopyRtoL = document.getElementById('btnEqCopyRtoL');

        if (btnEqReset) btnEqReset.addEventListener('click', () => this.eq.reset());
        if (btnEqInvert) btnEqInvert.addEventListener('click', () => this.eq.invert());
        if (btnEqCopyLtoR) btnEqCopyLtoR.addEventListener('click', () => this.eq.copyLtoR());
        if (btnEqCopyRtoL) btnEqCopyRtoL.addEventListener('click', () => this.eq.copyRtoL());

        // Output
        const btnRefreshOutputs = document.getElementById('btnRefreshOutputs');
        if (btnRefreshOutputs) btnRefreshOutputs.addEventListener('click', () => this.output.refresh());

        // Settings
        const btnSettingsSave = document.getElementById('btnSettingsSave');
        const btnSettingsLoad = document.getElementById('btnSettingsLoad');
        const btnSettingsReset = document.getElementById('btnSettingsReset');
        const btnSettingsExport = document.getElementById('btnSettingsExport');
        const btnSettingsImport = document.getElementById('btnSettingsImport');

        if (btnSettingsSave) btnSettingsSave.addEventListener('click', () => this.settings.save());
        if (btnSettingsLoad) btnSettingsLoad.addEventListener('click', () => this.settings.load());
        if (btnSettingsReset) btnSettingsReset.addEventListener('click', () => this.settings.reset());
        if (btnSettingsExport) btnSettingsExport.addEventListener('click', () => this.settings.export());
        if (btnSettingsImport) btnSettingsImport.addEventListener('click', () => this.settings.import());
    }

    updateChannelGains() {
        const volL = parseFloat(document.getElementById('volL')?.value || 100);
        const volR = parseFloat(document.getElementById('volR')?.value || 100);
        const balance = parseFloat(document.getElementById('balance')?.value || 0) / 100;

        this.audio.setChannelVolume('L', volL, balance, this.muted.L);
        this.audio.setChannelVolume('R', volR, balance, this.muted.R);
    }

    setupKeyboard() {
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;
            if (e.code === 'Space') {
                e.preventDefault();
                this.playlist.togglePlay();
            }
            if (e.key === 'ArrowRight') this.playlist.next();
            if (e.key === 'ArrowLeft') this.playlist.prev();
            if (e.key === 'm' || e.key === 'M') {
                this.muted.L = !this.muted.L;
                this.muted.R = !this.muted.R;
                ['L', 'R'].forEach(ch => {
                    const btn = document.getElementById('mute' + ch);
                    if (btn) {
                        btn.classList.toggle('active', this.muted[ch]);
                        btn.textContent = this.muted[ch] ? 'Unmute' : 'Mute';
                    }
                });
                this.updateChannelGains();
            }
        });
    }
}

// ==================== INITIALIZATION ====================
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new App();
    app.init();
    console.log('%c⚡ Poweramp Web v3.0', 'color:#00ff88;font-size:16px;font-weight:bold;');
    console.log('%cProfessional Audio Processor - Ready', 'color:#00d2d3;');
});

