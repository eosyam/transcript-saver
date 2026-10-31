(() => {
  const KOK_ID = 'transcript-saver-root';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ZAMAN_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

  // ---------- Arayüz dili: tarayıcı Türkçeyse Türkçe, değilse İngilizce ----------
  const TR = (typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('tr'));
  const S = TR ? {
    title: 'Transkript',
    copy: 'Kopyala',
    openPanel: 'Önce transkript panelini aç',
    collecting: n => `Toplanıyor… ${n}`,
    downloaded: n => `İndirildi: ${n} konuşma`,
    copied: n => `Kopyalandı: ${n} konuşma`,
    copyRetry: 'Hazır, tekrar Kopyala\'ya bas',
    copyFailed: 'Kopyalanamadı',
    noSrt: 'Bu transkriptte zaman bilgisi bulunamadı',
    fileSuffix: 'transkript',
    fallbackTitle: 'toplanti',
    askRate: 'İşine yaradı mı?',
    rate: 'Chrome Web Store\'da puan ver ★',
    later: 'Belki sonra',
  } : {
    title: 'Transcript',
    copy: 'Copy',
    openPanel: 'Open the transcript panel first',
    collecting: n => `Collecting… ${n}`,
    downloaded: n => `Downloaded: ${n} entries`,
    copied: n => `Copied: ${n} entries`,
    copyRetry: 'Ready, click Copy again',
    copyFailed: 'Could not copy',
    noSrt: 'No timing info found in this transcript',
    fileSuffix: 'transcript',
    fallbackTitle: 'meeting',
    askRate: 'Did it save you time?',
    rate: 'Rate it on the Chrome Web Store ★',
    later: 'Maybe later',
  };

  // Yorum isteği: yalnızca ilk başarılı indirmeden sonra, bir kez (tek bayrak: chrome.storage.local)
  const YORUM_URL = 'https://chromewebstore.google.com/detail/inbgpffmjeipkhmbiihfbgfkdniccoln/reviews';
  const YORUM_BAYRAK = 'yorumSoruldu';

  // ---------- Ayrıştırma ----------
  // Panel yapısı (her konuşmacı bloğu):
  //   [Baş harfler]            ör. "NB" (fotoğraf yoksa)
  //   Ad Soyad (Şirket)
  //   0 dakika 19 saniye
  //   0:19
  //   Ad Soyad (Şirket) 0 dakika 19 saniye    <- her konuşmanın başlığı
  //   Konuşma metni
  const BIRIM = {
    saat: 3600, hour: 3600, hours: 3600,
    dakika: 60, minute: 60, minutes: 60,
    saniye: 1, second: 1, seconds: 1,
  };
  const SURE_PARCA = '\\d+\\s+(?:saat|dakika|saniye|hours?|minutes?|seconds?)';
  const SURE_RE = new RegExp(`^(?:${SURE_PARCA}\\s*){1,3}$`, 'i');
  const KONUSMA_RE = new RegExp(`^(.+?)\\s+((?:${SURE_PARCA}\\s*){1,3})$`, 'i');
  const SAAT_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  const BAS_HARF_RE = /^[A-ZÇĞİÖŞÜ]{1,3}$/;
  const OLAY_RE = /(dökümü|transkripsiyonu|transkripti|kaydı)\s+(başlattı|durdurdu)|(started|stopped)\s+(transcription|recording)/i;

  const saniyeye = sure => {
    let s = 0;
    sure.replace(/(\d+)\s+(\S+)/g, (_, n, b) => { s += +n * (BIRIM[b.toLowerCase()] || 0); });
    return s;
  };

  // "NB" gibi satır gerçekten "Nazlı Merve Başar" gibi bir ismin baş harfleri mi?
  const basHarfMi = (s, isim) => {
    if (!BAS_HARF_RE.test(s) || !isim) return false;
    const h = isim.replace(/\(.*?\)/g, ' ').trim().split(/\s+/).filter(Boolean).map(w => w[0].toLocaleUpperCase('tr'));
    return h.length > 0 && s[0] === h[0] && (s.length === 1 || s[s.length - 1] === h[h.length - 1]);
  };
  const bilinenBasHarf = (s, d) => [...d.konusmacilar].some(n => basHarfMi(s, n));

  const yeniDurum = () => ({ kayitlar: new Map(), konusmacilar: new Set(), sira: 0, maxSn: -1, ham: [], hamGorulen: new Set() });

  // Panelin o anki görünen metnini işler; kayıtlar konuşmacı+zaman anahtarıyla birikir
  function ayristir(metin, d) {
    const L = metin.split('\n').map(s => s.trim()).filter(Boolean);

    // Ham yedek (ayrıştırma hiçbir şey bulamazsa kullanılır)
    for (const s of L) if (!d.hamGorulen.has(s)) { d.hamGorulen.add(s); d.ham.push(s); }

    // Başlık isimlerini öğren: ardından süre satırı gelen satır
    for (let i = 0; i < L.length - 1; i++) {
      if (SURE_RE.test(L[i + 1]) && !SURE_RE.test(L[i]) && !SAAT_RE.test(L[i])) d.konusmacilar.add(L[i]);
    }

    let aktif = null, tampon = [], sonSn = -1;
    const bosalt = tamamlandi => {
      if (aktif && tampon.length) {
        if (tamamlandi) { aktif.parcalar = tampon; aktif.kesin = true; }
        else if (!aktif.kesin && tampon.join(' ').length > aktif.parcalar.join(' ').length) aktif.parcalar = tampon;
      }
      aktif = null; tampon = [];
    };

    for (let i = 0; i < L.length; i++) {
      const s = L[i], sonraki = L[i + 1] || '', ikiSonraki = L[i + 2] || '';

      const k = KONUSMA_RE.exec(s);
      if (k && !SURE_RE.test(s) && (d.konusmacilar.size === 0 || d.konusmacilar.has(k[1]))) {
        bosalt(true);
        const sn = saniyeye(k[2]);
        sonSn = sn;
        if (sn > d.maxSn) d.maxSn = sn;
        const anahtar = k[1] + '|' + sn;
        aktif = d.kayitlar.get(anahtar);
        if (!aktif) {
          aktif = { tur: 'konusma', konusmaci: k[1], sn, parcalar: [], kesin: false, sira: d.sira++ };
          d.kayitlar.set(anahtar, aktif);
        }
        continue;
      }

      if (OLAY_RE.test(s)) {
        bosalt(true);
        if (i === 0) continue; // kimin yaptığı görünmüyor; bir önceki/sonraki görüntüde tam yakalanır
        const onceki = L[i - 1];
        const kim = !SURE_RE.test(onceki) && !SAAT_RE.test(onceki) && !KONUSMA_RE.test(onceki) ? onceki : '';
        const anahtar = 'olay|' + kim + '|' + s;
        if (!d.kayitlar.has(anahtar)) {
          d.kayitlar.set(anahtar, {
            tur: 'olay', metin: (kim ? kim + ' ' : '') + s,
            sn: sonSn !== -1 ? sonSn : d.maxSn, sira: d.sira++,
          });
        }
        continue;
      }

      const yapisal =
        SURE_RE.test(s) || SAAT_RE.test(s) ||
        (basHarfMi(s, sonraki) && (SURE_RE.test(ikiSonraki) || !ikiSonraki)) ||
        d.konusmacilar.has(s) ||
        SURE_RE.test(sonraki) || OLAY_RE.test(sonraki);
      if (yapisal) { bosalt(true); continue; }

      if (aktif) tampon.push(s);
    }
    bosalt(false); // görüntünün altında kesilmiş olabilir
  }

  // Görüntünün altında kesilmiş metinlerden sonradan öğrenilen başlık satırlarını (baş harf, isim) temizle
  function metinAl(k, d) {
    const p = [...k.parcalar];
    if (!k.kesin) {
      while (p.length && (d.konusmacilar.has(p[p.length - 1]) || bilinenBasHarf(p[p.length - 1], d))) p.pop();
    }
    return p.join(' ');
  }

  function siraliKayitlar(d) {
    return [...d.kayitlar.values()]
      .map(k => (k.tur === 'olay' ? k : { ...k, metin: metinAl(k, d) }))
      .filter(k => k.tur === 'olay' || k.metin)
      .sort((a, b) => a.sn - b.sn || a.sira - b.sira);
  }

  // Art arda aynı konuşmacının konuşmalarını tek blokta topla
  function gruplar(kayitlar) {
    const g = [];
    for (const k of kayitlar) {
      const son = g[g.length - 1];
      if (k.tur === 'olay') g.push({ tur: 'olay', metin: k.metin });
      else if (son && son.tur === 'konusma' && son.konusmaci === k.konusmaci) son.satirlar.push(k.metin);
      else g.push({ tur: 'konusma', konusmaci: k.konusmaci, sn: k.sn, satirlar: [k.metin] });
    }
    return g;
  }

  // ---------- Çıktılar ----------
  const p2 = n => String(n).padStart(2, '0');
  const zaman = sn => {
    const h = Math.floor(sn / 3600), m = Math.floor(sn % 3600 / 60), s = sn % 60;
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
  };
  const srtZaman = sn => `${p2(Math.floor(sn / 3600))}:${p2(Math.floor(sn % 3600 / 60))}:${p2(sn % 60)},000`;

  function txtYap(d, baslik) {
    const k = siraliKayitlar(d);
    if (!k.some(x => x.tur === 'konusma')) return { metin: d.ham.join('\n'), adet: d.ham.length };
    const govde = gruplar(k).map(g => g.tur === 'olay'
      ? `— ${g.metin} —`
      : `${g.konusmaci}  [${zaman(g.sn)}]\n${g.satirlar.join('\n')}`).join('\n\n');
    return { metin: `${baslik}\n\n${govde}\n`, adet: k.filter(x => x.tur === 'konusma').length };
  }

  function srtYap(d) {
    const k = siraliKayitlar(d).filter(x => x.tur === 'konusma');
    if (!k.length) return null;
    const bloklar = k.map((x, i) => {
      const sonraki = k.slice(i + 1).find(y => y.sn > x.sn);
      const bitis = Math.min(sonraki ? sonraki.sn : x.sn + 5, x.sn + 15);
      return `${i + 1}\n${srtZaman(x.sn)} --> ${srtZaman(Math.max(bitis, x.sn + 1))}\n${x.konusmaci}: ${x.metin}`;
    });
    return { metin: bloklar.join('\n\n') + '\n', adet: k.length };
  }

  // --- Minimal .docx üretimi (kütüphanesiz, sıkıştırmasız zip) ---
  const CRC_TABLO = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = b => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = CRC_TABLO[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  function zipYap(dosyalar) {
    const enc = new TextEncoder();
    const parcalar = [], merkez = [];
    let ofset = 0;
    for (const f of dosyalar) {
      const ad = enc.encode(f.ad), veri = enc.encode(f.icerik), crc = crc32(veri), n = veri.length;
      const yerel = new Uint8Array(30 + ad.length), v = new DataView(yerel.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
      v.setUint16(8, 0, true); v.setUint16(10, 0, true); v.setUint16(12, 0x21, true);
      v.setUint32(14, crc, true); v.setUint32(18, n, true); v.setUint32(22, n, true);
      v.setUint16(26, ad.length, true); v.setUint16(28, 0, true); yerel.set(ad, 30);

      const m = new Uint8Array(46 + ad.length), w = new DataView(m.buffer);
      w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true);
      w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true); w.setUint16(12, 0, true);
      w.setUint16(14, 0x21, true); w.setUint32(16, crc, true); w.setUint32(20, n, true);
      w.setUint32(24, n, true); w.setUint16(28, ad.length, true); w.setUint32(42, ofset, true);
      m.set(ad, 46);

      parcalar.push(yerel, veri);
      merkez.push(m);
      ofset += yerel.length + n;
    }
    const merkezBoyut = merkez.reduce((a, b) => a + b.length, 0);
    const son = new Uint8Array(22), e = new DataView(son.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, dosyalar.length, true);
    e.setUint16(10, dosyalar.length, true); e.setUint32(12, merkezBoyut, true); e.setUint32(16, ofset, true);
    return [...parcalar, ...merkez, son];
  }

  const xe = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
  const run = (t, o = {}) =>
    `<w:r><w:rPr>${FONT}${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}${o.renk ? `<w:color w:val="${o.renk}"/>` : ''}` +
    `<w:sz w:val="${o.boyut || 22}"/></w:rPr><w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;
  const par = (icerik, once = 0, sonra = 60) =>
    `<w:p><w:pPr><w:spacing w:before="${once}" w:after="${sonra}"/></w:pPr>${icerik}</w:p>`;

  function docxYap(d, baslik) {
    const k = siraliKayitlar(d);
    let govde = par(run(baslik, { b: true, boyut: 32 }), 0, 240);
    let adet;
    if (!k.some(x => x.tur === 'konusma')) {
      govde += d.ham.map(s => par(run(s))).join('');
      adet = d.ham.length;
    } else {
      for (const g of gruplar(k)) {
        if (g.tur === 'olay') { govde += par(run(g.metin, { i: true, renk: '808080' }), 160); continue; }
        govde += par(run(g.konusmaci, { b: true }) + run('   ' + zaman(g.sn), { renk: '808080', boyut: 18 }), 200, 40);
        govde += g.satirlar.map(s => par(run(s))).join('');
      }
      adet = k.filter(x => x.tur === 'konusma').length;
    }
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const dosyalar = [
      { ad: '[Content_Types].xml', icerik: `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
      { ad: '_rels/.rels', icerik: `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
      { ad: 'word/document.xml', icerik: `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${govde}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>` },
    ];
    return { parcalar: zipYap(dosyalar), adet };
  }

  // Test kancası (sayfada etkisiz)
  if (typeof globalThis !== 'undefined' && globalThis.__TS_TEST__) {
    Object.assign(globalThis.__TS_TEST__, { yeniDurum, ayristir, siraliKayitlar, txtYap, srtYap, docxYap });
    return;
  }

  // ---------- Panel bulma ve toplama ----------
  const oynaticiSayfasiMi = () => /stream\.aspx/i.test(location.href);

  function paneliBul() {
    const adaylar = [...document.querySelectorAll('div, section, ul')]
      .filter(e => e.scrollHeight > e.clientHeight + 150 && e.clientHeight > 80);
    if (!adaylar.length) return null;
    const puan = e => (e.innerText.match(ZAMAN_RE) || []).length;
    adaylar.sort((a, b) => puan(b) - puan(a) || b.scrollHeight - a.scrollHeight);
    return puan(adaylar[0]) > 0 ? adaylar[0] : null;
  }

  async function topla(panel, ilerleme) {
    const eskiTop = panel.scrollTop;
    const d = yeniDurum();
    const yakala = () => { ayristir(panel.innerText, d); ilerleme(d.kayitlar.size || d.ham.length); };

    panel.scrollTop = 0;
    await sleep(600);
    yakala();

    let oncekiTop = -1, takilma = 0;
    while (panel.scrollTop + panel.clientHeight < panel.scrollHeight - 5) {
      panel.scrollTop += panel.clientHeight * 0.5;
      await sleep(400);
      yakala();
      if (panel.scrollTop === oncekiTop) { if (++takilma > 3) break; }
      else { takilma = 0; oncekiTop = panel.scrollTop; }
    }
    await sleep(400);
    yakala();

    panel.scrollTop = eskiTop;
    return d;
  }

  // ---------- Dosya / pano ----------
  function baslikAl() {
    return (document.title || S.fallbackTitle).replace(/\s+/g, ' ').trim();
  }
  function dosyaAdi(uzanti) {
    const b = baslikAl().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `${b} - ${S.fileSuffix}.${uzanti}`;
  }
  function indir(parcalar, tip, ad) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(parcalar, { type: tip }));
    a.download = ad;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  let calisiyor = false;
  let onbellek = { url: null, durum: null };
  let durumEl = null;
  let yorumEl = null;
  const durum = t => { if (durumEl) durumEl.textContent = t; };

  // İlk başarılı indirmeden sonra bir kez nazikçe puan ister; hata verirse indirmeyi asla bozmaz
  async function yorumIste() {
    try {
      if (!yorumEl || !globalThis.chrome?.storage?.local) return;
      const kayit = await chrome.storage.local.get(YORUM_BAYRAK);
      if (kayit[YORUM_BAYRAK]) return;
      await chrome.storage.local.set({ [YORUM_BAYRAK]: true });
      yorumEl.hidden = false;
    } catch { /* sessizce geç */ }
  }

  async function veriAl() {
    if (onbellek.url === location.href && onbellek.durum) return onbellek.durum;
    const panel = paneliBul();
    if (!panel) throw new Error(S.openPanel);
    const d = await topla(panel, n => durum(S.collecting(n)));
    onbellek = { url: location.href, durum: d };
    return d;
  }

  async function calistir(mod) {
    if (calisiyor) return;
    calisiyor = true;
    try {
      const hazirdi = onbellek.url === location.href && !!onbellek.durum;
      const d = await veriAl();
      const baslik = baslikAl();
      if (mod === 'txt') {
        const r = txtYap(d, baslik);
        indir([r.metin], 'text/plain;charset=utf-8', dosyaAdi('txt'));
        durum(S.downloaded(r.adet));
        yorumIste();
      } else if (mod === 'docx') {
        const r = docxYap(d, baslik);
        indir(r.parcalar, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dosyaAdi('docx'));
        durum(S.downloaded(r.adet));
        yorumIste();
      } else if (mod === 'srt') {
        const r = srtYap(d);
        if (!r) durum(S.noSrt);
        else { indir([r.metin], 'application/x-subrip;charset=utf-8', dosyaAdi('srt')); durum(S.downloaded(r.adet)); yorumIste(); }
      } else {
        const r = txtYap(d, baslik);
        try {
          await navigator.clipboard.writeText(r.metin);
          durum(S.copied(r.adet));
        } catch {
          // Uzun toplama sırasında tıklama izni düşebiliyor; veri hazır, ikinci tık anında kopyalar
          durum(hazirdi ? S.copyFailed : S.copyRetry);
        }
      }
    } catch (e) {
      durum(e.message);
    }
    calisiyor = false;
  }

  // ---------- Arayüz ----------
  function arayuzEkle() {
    if (document.getElementById(KOK_ID)) return;
    const host = document.createElement('div');
    host.id = KOK_ID;
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const kok = host.attachShadow({ mode: 'open' });
    kok.innerHTML = `
      <style>
        .k { display:flex; align-items:center; gap:6px; padding:8px 8px 8px 12px; border-radius:10px;
             background:#1f1f1f; color:#fff; font:13px/1.3 "Segoe UI",system-ui,sans-serif;
             box-shadow:0 4px 16px rgba(0,0,0,.3); }
        .t { font-weight:600; margin-right:4px; opacity:.9; }
        button { border:0; border-radius:6px; padding:7px 10px; cursor:pointer; font:inherit; font-weight:600;
                 background:#5b5fc7; color:#fff; }
        button:hover { background:#4f52b2; }
        #kopya { background:#3a3a3a; }
        #kopya:hover { background:#4a4a4a; }
        #durum { padding:0 4px; opacity:.85; max-width:220px; }
        #durum:empty { display:none; }
        .y { display:flex; align-items:center; gap:10px; justify-content:flex-end; margin-bottom:6px; padding:8px 12px;
             border-radius:10px; background:#1f1f1f; color:#fff; font:13px/1.3 "Segoe UI",system-ui,sans-serif;
             box-shadow:0 4px 16px rgba(0,0,0,.3); }
        .y[hidden] { display:none; }
        .y a { color:#fff; background:#5b5fc7; border-radius:6px; padding:6px 10px; font-weight:600; text-decoration:none; }
        .y a:hover { background:#4f52b2; }
        #sonra { background:transparent; color:#bbb; padding:6px 8px; font-weight:400; }
        #sonra:hover { background:#3a3a3a; }
      </style>
      <div class="y" id="yorum" hidden>
        <span>${S.askRate}</span>
        <a href="${YORUM_URL}" target="_blank" rel="noopener" id="puan">${S.rate}</a>
        <button id="sonra">${S.later}</button>
      </div>
      <div class="k">
        <span class="t">⬇ ${S.title}</span>
        <button data-mod="txt">TXT</button>
        <button data-mod="docx">Word</button>
        <button data-mod="srt">SRT</button>
        <button data-mod="kopya" id="kopya">${S.copy}</button>
        <span id="durum"></span>
      </div>`;
    document.body.appendChild(host);
    durumEl = kok.getElementById('durum');
    yorumEl = kok.getElementById('yorum');
    const yorumKapat = () => { yorumEl.hidden = true; };
    kok.getElementById('sonra').addEventListener('click', yorumKapat);
    kok.getElementById('puan').addEventListener('click', yorumKapat);
    kok.querySelectorAll('button[data-mod]').forEach(b => b.addEventListener('click', () => calistir(b.dataset.mod)));
  }

  function arayuzKaldir() {
    document.getElementById(KOK_ID)?.remove();
    durumEl = null;
    yorumEl = null;
  }

  // SharePoint sayfa içi gezinmelerinde butonları göster/gizle
  const kontrol = () => (oynaticiSayfasiMi() ? arayuzEkle() : arayuzKaldir());
  kontrol();
  setInterval(kontrol, 1500);
})();
