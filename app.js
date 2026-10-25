'use strict';
/*
 * Canlı Altyazı (web): İngilizce konuşmayı yazıya döker ve Türkçeye çevirir.
 * iOS sürümündeki mimarinin aynısı:
 *   Konuşma (SpeechRecognition) ──partial/final──▶ segmentler ──submit──▶ Çeviri (debounce, önbellek, yedek zinciri)
 */

// ───────────────────────── Ayarlar ─────────────────────────
const SILENCE_MS = 1400;        // Bu kadar sessizlikte satır kapanır.
const PARTIAL_DEBOUNCE_MS = 700; // Konuşma sürerken çeviri için bekleme.
const REQUEST_TIMEOUT_MS = 5000;
const MAX_SEGMENTS = 200;

// ───────────────────────── Durum ─────────────────────────
/** @type {{id:number, en:string, tr:string, final:boolean, status:string, error?:string}[]} */
let segments = [];
let activeId = null;
let nextId = 1;
let recording = false;

const $ = (id) => document.getElementById(id);
const els = {
  list: $('list'), empty: $('empty'), emptyTitle: $('emptyTitle'), emptyText: $('emptyText'),
  record: $('recordBtn'), hint: $('hint'), provider: $('provider'),
  indicator: $('indicator'), clear: $('clearBtn'), banner: $('banner'),
  dialog: $('dialog'), dialogTitle: $('dialogTitle'), dialogText: $('dialogText'), dialogOk: $('dialogOk'),
};
/** Segment id → kart öğeleri */
const cards = new Map();

// ───────────────────────── Arayüz ─────────────────────────
function isNearBottom() {
  const l = els.list;
  return l.scrollHeight - l.scrollTop - l.clientHeight < 120;
}

function scrollToBottom() {
  els.list.scrollTo({ top: els.list.scrollHeight, behavior: 'smooth' });
}

function renderSegment(seg) {
  let c = cards.get(seg.id);
  if (!c) {
    const root = document.createElement('article');
    root.className = 'card';
    root.innerHTML = '<div class="bar"></div><div class="texts"><p class="en" lang="en"></p><p class="tr" lang="tr"></p><p class="note"></p></div>';
    c = { root, en: root.querySelector('.en'), tr: root.querySelector('.tr'), note: root.querySelector('.note') };
    cards.set(seg.id, c);
    els.list.appendChild(root);
  }
  const provisional = seg.status === 'provisional' || !seg.final;
  c.root.classList.toggle('active', !seg.final);
  c.en.textContent = seg.en;

  if (seg.tr) {
    c.tr.textContent = seg.tr;
    c.tr.className = 'tr' + (provisional ? ' provisional' : '');
    c.tr.hidden = false;
  } else if (seg.status === 'translating' || seg.status === 'idle') {
    c.tr.textContent = 'Çevriliyor…';
    c.tr.className = 'tr pending';
    c.tr.hidden = false;
  } else {
    c.tr.hidden = true;
  }

  if (seg.status === 'waiting') {
    c.note.textContent = '⟳ Bağlantı bekleniyor, gelince çevrilecek';
    c.note.className = 'note';
    c.note.hidden = false;
  } else if (seg.status === 'failed') {
    c.note.textContent = '⚠︎ Çeviri başarısız: ' + (seg.error || '');
    c.note.className = 'note error';
    c.note.hidden = false;
  } else {
    c.note.hidden = true;
  }
}

function update(seg) {
  const stick = isNearBottom();
  renderSegment(seg);
  refreshChrome();
  if (stick) scrollToBottom();
}

function refreshChrome() {
  const empty = segments.length === 0;
  els.empty.hidden = !empty;
  els.clear.disabled = empty;
  els.emptyTitle.textContent = recording ? 'Dinleniyor…' : 'Henüz altyazı yok';
  els.emptyText.textContent = recording ? 'İngilizce konuşma bekleniyor.' : 'Başlamak için mikrofon düğmesine dokunun.';

  els.record.classList.toggle('on', recording);
  els.record.setAttribute('aria-label', recording ? 'Kaydı durdur' : 'Kaydı başlat');
  els.hint.textContent = recording ? 'Durdurmak için dokunun' : 'Başlatmak için dokunun';
  els.indicator.classList.toggle('live', recording);
  els.indicator.querySelector('.label').textContent = recording ? 'CANLI' : 'HAZIR';
}

let bannerTimer = null;
function showBanner(text, autoHide = true) {
  clearTimeout(bannerTimer);
  els.banner.textContent = text;
  els.banner.hidden = false;
  if (autoHide) bannerTimer = setTimeout(hideBanner, 3000);
}
function hideBanner() {
  els.banner.hidden = true;
  if (!navigator.onLine) showBanner('📵 Çevrimdışı: bağlantı gelince çeviriler tamamlanacak', false);
}

function showDialog(title, text) {
  els.dialogTitle.textContent = title;
  els.dialogText.textContent = text;
  els.dialog.hidden = false;
  els.dialogOk.focus();
}
els.dialogOk.addEventListener('click', () => { els.dialog.hidden = true; });

// ───────────────────────── Segmentler ─────────────────────────
function findSeg(id) {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].id === id) return segments[i];
  return null;
}

function trimIfNeeded() {
  while (segments.length > MAX_SEGMENTS) {
    const old = segments.shift();
    cards.get(old.id)?.root.remove();
    cards.delete(old.id);
  }
}

function handlePartial(text) {
  let seg = activeId != null ? findSeg(activeId) : null;
  if (seg) {
    seg.en = text;
  } else {
    seg = { id: nextId++, en: text, tr: '', final: false, status: 'idle' };
    segments.push(seg);
    activeId = seg.id;
    trimIfNeeded();
  }
  update(seg);
  translator.submit(seg.id, text, false);
}

function handleFinal(text) {
  let seg = activeId != null ? findSeg(activeId) : null;
  if (seg) {
    seg.en = text;
    seg.final = true;
  } else {
    seg = { id: nextId++, en: text, tr: '', final: true, status: 'idle' };
    segments.push(seg);
    trimIfNeeded();
  }
  activeId = null;
  update(seg);
  translator.submit(seg.id, text, true);
}

function applyOutcome(id, outcome) {
  const seg = findSeg(id);
  if (!seg) return; // Temizlenmiş olabilir.
  switch (outcome.type) {
    case 'translating':
      seg.status = 'translating';
      break;
    case 'translated':
      // Final çeviri geldikten sonra geç kalan geçici sonuç onu ezmesin.
      if (outcome.provisional && seg.status === 'done') return;
      seg.tr = outcome.text;
      seg.status = outcome.provisional ? 'provisional' : 'done';
      break;
    case 'waiting':
      seg.status = 'waiting';
      break;
    case 'failed':
      seg.status = 'failed';
      seg.error = outcome.message;
      break;
  }
  update(seg);
}

function clearAll() {
  translator.reset();
  segments = [];
  activeId = null;
  cards.forEach((c) => c.root.remove());
  cards.clear();
  speech.forgetCurrent();
  refreshChrome();
}
els.clear.addEventListener('click', clearAll);

// ───────────────────────── Çeviri ─────────────────────────
class TranslateError extends Error {
  constructor(message, retryLater) { super(message); this.retryLater = retryLater; }
}

/** Zaman aşımı ve dış iptal sinyaliyle fetch. */
async function fetchJSON(url, signal) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new TranslateError('Sunucu hata döndürdü (HTTP ' + res.status + ')', res.status >= 500 || res.status === 429);
    return await res.json();
  } catch (e) {
    if (signal.aborted) throw e;                       // Bilerek iptal edildi.
    if (e instanceof TranslateError) throw e;
    throw new TranslateError('Ağ hatası', true);        // Zaman aşımı veya bağlantı yok.
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Sağlayıcı zinciri: sırayla denenir. */
const providers = [
  {
    name: 'Google Translate',
    async translate(text, signal) {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&q=' + encodeURIComponent(text);
      const data = await fetchJSON(url, signal);
      const out = (data?.[0] || []).map((p) => p?.[0] || '').join('').trim();
      if (!out) throw new TranslateError('Boş sonuç', false);
      return out;
    },
  },
  {
    name: 'MyMemory',
    async translate(text, signal) {
      const url = 'https://api.mymemory.translated.net/get?langpair=en%7Ctr&q=' + encodeURIComponent(text);
      const data = await fetchJSON(url, signal);
      const out = data?.responseData?.translatedText?.trim();
      if (data?.responseStatus !== 200 || !out) throw new TranslateError(data?.responseDetails || 'Boş sonuç', false);
      return out;
    },
  },
];

const translator = {
  cache: new Map(),
  jobs: new Map(),        // id → { timer, ctrl }
  lastSent: new Map(),    // id → son gönderilen geçici metin
  pending: new Map(),     // id → ağ bekleyen final metin

  submit(id, text, isFinal) {
    const t = text.trim();
    if (!t) return;
    this.cancel(id);
    const job = { timer: null, ctrl: new AbortController() };
    this.jobs.set(id, job);

    if (isFinal) {
      this.lastSent.delete(id);
      this.perform(id, t, false, job);
    } else {
      job.timer = setTimeout(() => {
        if (job.ctrl.signal.aborted || t === this.lastSent.get(id)) return;
        this.lastSent.set(id, t);
        this.perform(id, t, true, job);
      }, PARTIAL_DEBOUNCE_MS);
    }
  },

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.ctrl.abort();
    this.jobs.delete(id);
  },

  reset() {
    [...this.jobs.keys()].forEach((id) => this.cancel(id));
    this.lastSent.clear();
    this.pending.clear();
  },

  async perform(id, text, provisional, job) {
    const signal = job.ctrl.signal;
    const done = () => { if (this.jobs.get(id) === job) this.jobs.delete(id); };

    const cached = this.cache.get(text);
    if (cached) {
      applyOutcome(id, { type: 'translated', text: cached, provisional });
      return done();
    }
    applyOutcome(id, { type: 'translating', provisional });

    let lastError = new TranslateError('İnternet bağlantısı yok', true);
    for (const p of providers) {
      if (!navigator.onLine) break;
      try {
        const out = await p.translate(text, signal);
        if (signal.aborted) return;
        if (this.cache.size >= 300) this.cache.clear();
        this.cache.set(text, out);
        this.pending.delete(id);
        els.provider.textContent = 'Çeviri: ' + p.name;
        els.provider.hidden = false;
        applyOutcome(id, { type: 'translated', text: out, provisional });
        return done();
      } catch (e) {
        if (signal.aborted) return;
        lastError = e;
      }
    }
    done();
    if (provisional) return; // Geçici çeviri başarısızsa sessizce geç; final yine gelecek.
    if (!navigator.onLine || lastError.retryLater) {
      this.pending.set(id, text);
      applyOutcome(id, { type: 'waiting' });
    } else {
      applyOutcome(id, { type: 'failed', message: lastError.message });
    }
  },

  retryPending() {
    const items = [...this.pending];
    this.pending.clear();
    items.forEach(([id, text]) => this.submit(id, text, true));
  },
};

window.addEventListener('online', () => { hideBanner(); showBanner('Bağlantı geri geldi.'); translator.retryPending(); });
window.addEventListener('offline', () => showBanner('📵 Çevrimdışı: bağlantı gelince çeviriler tamamlanacak', false));

// ───────────────────────── Konuşma tanıma ─────────────────────────
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const speech = {
  rec: null,
  wanted: false,        // Kullanıcı kayıt istiyor mu (motor kendiliğinden kapanınca yeniden başlatmak için).
  fullText: '',         // Bu tanıma oturumunun tüm metni.
  committedLen: 0,      // fullText'in önceki satırlara yazılmış kısmının uzunluğu.
  current: '',          // Şu anki satırın metni.
  silenceTimer: null,
  failures: 0,          // Arka arkaya sonuçsuz kapanmalar.
  gotResult: false,

  start() {
    this.wanted = true;
    this.failures = 0;
    this.open();
  },

  stop() {
    this.wanted = false;
    this.commit();
    try { this.rec?.stop(); } catch (_) { /* zaten kapalı */ }
  },

  open() {
    const rec = new Recognition();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.fullText = '';
    this.committedLen = 0;
    this.gotResult = false;

    rec.onresult = (e) => this.onResult(e);
    rec.onerror = (e) => this.onError(e);
    rec.onend = () => this.onEnd(rec);
    try {
      rec.start();
    } catch (err) {
      setRecording(false);
      showBanner('Kayıt başlatılamadı. Mikrofon düğmesine tekrar dokunun.', false);
    }
  },

  onResult(e) {
    // Sonuçları birleştir. iOS Safari bazen her sonuçta önceki metni tekrar gönderir;
    // yeni parça öncekini içeriyorsa eklemek yerine yerine koy.
    let full = '';
    for (let i = 0; i < e.results.length; i++) {
      const piece = e.results[i][0].transcript;
      const a = full.trim(), b = piece.trim();
      if (a && b.toLowerCase().startsWith(a.toLowerCase())) full = piece;
      else full += (full && !/^\s/.test(piece) ? ' ' : '') + piece;
    }
    this.fullText = full;
    if (this.committedLen > full.length) this.committedLen = full.length;

    const text = full.slice(this.committedLen).trim();
    if (!text || text === this.current) return;
    this.gotResult = true;
    this.failures = 0;
    this.current = text;
    handlePartial(text);

    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.commit();
      // Satır kapanınca oturumu tazele: biriken metin büyümez, iOS'un süre sınırına takılmaz.
      // onEnd yeni oturumu açar.
      try { this.rec?.abort(); } catch (_) { /* zaten kapalı */ }
    }, SILENCE_MS);
  },

  /** Şu anki satırı final olarak bildirir. */
  commit() {
    clearTimeout(this.silenceTimer);
    const text = this.current.trim();
    this.current = '';
    this.committedLen = this.fullText.length;
    if (text) handleFinal(text);
  },

  /** Ekran temizlenince yarım satırı unut (yeniden yazılmasın). */
  forgetCurrent() {
    clearTimeout(this.silenceTimer);
    this.current = '';
    this.committedLen = this.fullText.length;
  },

  onError(e) {
    switch (e.error) {
      case 'no-speech':
      case 'aborted':
        return; // Sessizlik / bilerek durdurma: normal.
      case 'not-allowed':
        this.wanted = false;
        setRecording(false);
        showDialog('Mikrofon izni gerekli',
          'Konuşmayı dinleyebilmek için mikrofon iznine ihtiyaç var.\n\niPhone: Ayarlar › Safari › Mikrofon › "İzin Ver" seçin, sonra sayfayı yenileyin.');
        return;
      case 'service-not-allowed':
        this.wanted = false;
        setRecording(false);
        showDialog('Konuşma tanıma kapalı',
          'iPhone\'da konuşma tanıma için Dikte açık olmalı.\n\nAyarlar › Genel › Klavye › "Dikteyi Etkinleştir" seçeneğini açıp tekrar deneyin.');
        return;
      case 'audio-capture':
        this.wanted = false;
        setRecording(false);
        showDialog('Mikrofon bulunamadı', 'Kullanılabilir bir mikrofon yok ya da başka bir uygulama kullanıyor.');
        return;
      case 'network':
        showBanner('Konuşma tanıma için internet gerekiyor, yeniden deneniyor…');
        return;
      default:
        console.warn('[speech]', e.error);
    }
  },

  onEnd(rec) {
    if (rec !== this.rec) return;
    this.commit();
    if (!this.wanted) { setRecording(false); return; }

    // Tarayıcı dinlemeyi kendiliğinden kapattı (iOS ~1 dk'da bir yapar): yeniden aç.
    // Sonuç gelmeden üst üste kapanıyorsa sonsuz döngüye girme.
    this.failures = this.gotResult ? 0 : this.failures + 1;
    if (this.failures >= 6) {
      this.wanted = false;
      setRecording(false);
      showBanner('Dinleme durdu. Devam etmek için mikrofon düğmesine dokunun.', false);
      return;
    }
    setTimeout(() => { if (this.wanted) this.open(); }, 250);
  },
};

// ───────────────────────── Kayıt düğmesi ─────────────────────────
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) { /* desteklenmiyor: önemli değil */ }
}

function setRecording(on) {
  recording = on;
  refreshChrome();
  keepScreenOn(on);
}

els.record.addEventListener('click', () => {
  if (!Recognition) {
    showDialog('Tarayıcı desteklemiyor',
      'Bu tarayıcıda konuşma tanıma yok.\n\niPhone\'da Safari, bilgisayarda Chrome veya Edge kullanın.');
    return;
  }
  navigator.vibrate?.(15);
  if (recording) {
    speech.stop();
    setRecording(false);
  } else {
    hideBanner();
    speech.start();
    setRecording(true);
  }
});

// Uygulama arka plana geçince kaydı durdur; öne gelince ekran kilidini yenile.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && recording) {
    speech.stop();
    setRecording(false);
    showBanner('Uygulamadan çıkıldığı için kayıt durdu. Devam etmek için dokunun.', false);
  }
});

refreshChrome();
if (!navigator.onLine) hideBanner();
