// matcher.js — čisté funkce pro párování názvů souborů z Webshare
// (bez sítě, aby šly snadno testovat)

// Slova, která se při porovnání názvů ignorují
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'und', 'le', 'la', 'les', 'der', 'die', 'das']);

// Odstraní diakritiku, malá písmena, & → and, vše mimo písmena/čísla → mezera
function normalize(str) {
    return String(str || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’`´]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tokens(str) {
    const n = normalize(str);
    return n ? n.split(' ') : [];
}

// Významná slova názvu (bez stopwords); když by nezbylo nic, vrátí všechna
function nameTokens(name) {
    const all = tokens(name);
    const sig = all.filter(t => !STOPWORDS.has(t));
    return sig.length ? sig : all;
}

// Text vhodný jako dotaz na Webshare (bez diakritiky a speciálních znaků)
function queryText(str) {
    return String(str || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[:!?*\/\\"„“]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Je název psaný latinkou (bez japonštiny, azbuky apod.)?
function isLatin(str) {
    return /^[\x00-\x7FÀ-ɏḀ-ỿ\s'’–—-]+$/.test(String(str || ''));
}

// Část názvu před dvojtečkou / pomlčkou s mezerami ("Pán prstenů: Společenstvo" → "Pán prstenů")
function shortTitle(str) {
    const s = String(str || '');
    const m = s.split(/\s*[:]\s+|\s+[-–—]\s+/)[0].trim();
    return m && m.length >= 3 && m !== s ? m : null;
}

// Pokud název obsahuje všechna významná slova hledaného názvu
// - jednoslovný název musí být na začátku souboru (do 3. slova) nebo hned před rokem,
//   aby "Batman" nesedělo na "Lego Batman" apod.
function titleMatches(fileName, name) {
    const ft = tokens(fileName);
    const nt = nameTokens(name);
    if (!nt.length || !ft.length) return false;
    const set = new Set(ft);
    if (!nt.every(t => set.has(t))) return false;
    if (nt.length === 1) {
        const sig = ft.filter(t => !STOPWORDS.has(t));
        const idx = sig.indexOf(nt[0]);
        if (idx === 0) return true;
        const next = sig[idx + 1];
        return !!next && /^(19|20)\d{2}$/.test(next);
    }
    return true;
}

// Roky v názvu souboru (1920–2035)
function fileYears(fileName) {
    const out = [];
    const re = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9]|p\b)/gi;
    let m;
    const s = String(fileName);
    while ((m = re.exec(s))) {
        const y = parseInt(m[1], 10);
        if (y >= 1920 && y <= 2035) out.push(y);
    }
    return out;
}

// Vyčistí název souboru od technických údajů, které se pletou s čísly epizod
function stripTech(n) {
    return n
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\b\d{3,4}\s*[pi]\b/g, ' ')
        .replace(/\b(4k|8k|uhd|fhd|hd|sd)\b/g, ' ')
        .replace(/\b[xh]\s*26[45]\b/g, ' ')
        .replace(/\b(hevc|avc|av1|xvid|divx)\b/g, ' ')
        .replace(/\b\d{1,2}\s*bit\b/g, ' ')
        .replace(/\b[1-9]\s+[01]\b/g, ' ')          // 5 1 / 7 1 / 2 0 (zvukové kanály po normalizaci)
        .replace(/\b(ddp?|dts|ac3|eac3|aac|flac|mp3|opus|truehd|atmos)\s*\d?\b/g, ' ')
        .replace(/\b\d{3,4}\s*x\s*\d{3,4}\b/g, ' ')    // 1920x1080
        .replace(/\b[0-9a-f]{8}\b/g, ' ')                // CRC [ABCD1234]
        .replace(/\s+/g, ' ')
        .trim();
}

// Rozpozná sezónu a epizodu z názvu souboru.
// excludeTokens = slova hledaného názvu (aby "Mob Psycho 100" nebylo epizoda 100)
// Vrací { season, episode, explicit } – explicit = měl SxxEyy / NxNN
function parseEpisode(fileName, excludeTokens) {
    let n = normalize(fileName);
    let season = null, episode = null, explicit = false;

    // S01E05, S1 E5, S01.E05, S01-E05
    let m = n.match(/\bs\s?(\d{1,2})\s?e\s?(\d{1,4})\b/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };
    // S01E05 slepené s dalším textem (např. "s01e05v2")
    m = n.match(/s(\d{1,2})e(\d{1,4})(?![0-9])/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };
    // 1x05
    m = n.match(/\b(\d{1,2})x(\d{2,4})\b/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };

    // Sezóna: "season 2", "2nd season", "s2", "2 serie", "2 rada"
    m = n.match(/\b(\d{1,2})(?:st|nd|rd|th)\s?season\b/) || n.match(/\bseason\s?(\d{1,2})\b/) ||
        n.match(/\b(\d{1,2})\s?season\b/) ||
        n.match(/\bs(\d{1,2})\b/) || n.match(/\b(\d{1,2})\s(?:serie|series|rada|sezona|seria)\b/) ||
        n.match(/\b(?:serie|rada|sezona|seria)\s(\d{1,2})\b/);
    if (m) season = +m[1];

    // Epizoda: "ep 05", "episode 5", "e05", "dil 5", "5 dil", "cast 5"
    m = n.match(/\b(?:ep|episode|epizoda|e)\s?(\d{1,4})\b/) ||
        n.match(/\b(\d{1,4})\s(?:dil|cast)\b/) || n.match(/\b(?:dil|cast)\s(\d{1,4})\b/);
    if (m && !/^(19|20)\d{2}$/.test(m[1])) return { season, episode: +m[1], explicit: false };

    // Holé číslo: nejdřív " - 05" v původním názvu, pak samostatné číslo
    const raw = String(fileName).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const dash = raw.match(/\s[-–]\s(\d{1,4})(?:v\d)?(?=[\s\[\(._]|$)/);
    const excl = new Set((excludeTokens || []).map(String));
    if (dash && !excl.has(String(+dash[1])) && !excl.has(dash[1])) {
        return { season, episode: +dash[1], explicit: false };
    }
    const nums = stripTech(n).split(' ').filter(t => /^\d{1,4}$/.test(t) && !excl.has(t) && !excl.has(String(+t)));
    // číslo sezóny ve tvaru "4 serie" je samostatný token – jednou ho odebereme
    if (season !== null) {
        const i = nums.findIndex(t => +t === season);
        if (i !== -1) nums.splice(i, 1);
    }
    if (nums.length >= 1) return { season, episode: +nums[0], explicit: false };
    m = n.match(/\b(\d{1,4})v\d\b/);
    if (m && !excl.has(String(+m[1]))) return { season, episode: +m[1], explicit: false };

    return { season, episode, explicit };
}

// Vypadá soubor jako díl seriálu? (pro filtrování filmů)
function looksLikeEpisode(fileName) {
    const n = normalize(fileName);
    return /\bs\s?\d{1,3}\s?e\s?\d{1,4}\b/.test(n) || /s\d{1,3}e\d{1,4}/.test(n) ||
        /\b\d{1,2}x\d{2,3}\b/.test(n) || /\b(?:ep|episode|epizoda)\s?\d{1,4}\b/.test(n) ||
        /\be\d{2,3}\b/.test(n) || /\b\d{1,3}\s(?:dil|cast)\b/.test(n) || /\b(?:dil|cast)\s\d{1,3}\b/.test(n);
}

// Jazyk a typ zvuku z názvu (po celých slovech)
function detectLang(fileName) {
    const n = ' ' + normalize(fileName).replace(/(cz|sk|en)(tit|dab|sub)/g, '$1 $2') + ' ';
    const has = re => re.test(n);
    const cz = has(/\s(cz|cze|czech|cesky|cestina|cs)\s/);
    const sk = has(/\s(sk|svk|slovak|slovensky|slovencina)\s/);
    const en = has(/\s(en|eng|english)\s/);
    const multi = has(/\s(multi|dual)\s/);
    const dub = has(/\s(dab|dabing|dabbing|dabovane|dabovany|dub|dubbed|rychlodabing)\s/);
    const sub = has(/\s(tit|titulky|titulkami|sub|subs|subtitles|forced)\s/);
    return { cz, sk, en, multi, dub, sub };
}

// Skóre jazyka pro řazení (CZ dabing > CZ > CZ titulky > SK …)
function langScore(l) {
    if (l.cz) return l.dub ? 50 : l.sub ? 30 : 40;
    if (l.sk) return l.dub ? 35 : l.sub ? 20 : 25;
    if (l.multi) return 5;
    return 0;
}

function detectQuality(fileName) {
    const n = ' ' + normalize(fileName) + ' ';
    let resolution = null, score = 0;
    if (/\s(2160p|4k|uhd)\s/.test(n)) { resolution = '4K'; score = 4; }
    else if (/\s1080[pi]\s/.test(n) || /\sfhd\s/.test(n)) { resolution = '1080p'; score = 3; }
    else if (/\s720p\s/.test(n) || /\shd\s/.test(n)) { resolution = '720p'; score = 2; }
    else if (/\s(576p|480p|360p|sd|dvdrip|xvid)\s/.test(n)) { resolution = 'SD'; score = 1; }
    const cam = /\s(cam|camrip|hdcam|ts|telesync|tc|hdts)\s/.test(n);
    if (cam) score = -1;
    const codec = /\s(hevc|x265|h265)\s/.test(n) ? 'HEVC' : /\s(x264|h264|avc)\s/.test(n) ? 'H.264' : /\sav1\s/.test(n) ? 'AV1' : null;
    const audio = /\s(truehd|atmos)\s/.test(n) ? 'TrueHD' : /\sdts\s/.test(n) ? 'DTS' : /\s(eac3|ddp)\s/.test(n) ? 'DD+' : /\s(ac3|dd)\s/.test(n) ? 'AC3' : /\saac\s/.test(n) ? 'AAC' : null;
    const hdr = /\s(hdr|hdr10|dv|dolby vision)\s/.test(n);
    const source = /\sremux\s/.test(n) ? 'REMUX' : /\s(bluray|bdrip|brrip|bd)\s/.test(n) ? 'BluRay' : /\s(web dl|webdl|webrip|web)\s/.test(n) ? 'WEB' : /\s(dvdrip|dvd)\s/.test(n) ? 'DVD' : /\shdtv\s/.test(n) ? 'HDTV' : null;
    return { resolution, score, codec, audio, hdr, source, cam };
}

module.exports = {
    normalize, tokens, nameTokens, queryText, isLatin, shortTitle,
    titleMatches, fileYears, parseEpisode, looksLikeEpisode,
    detectLang, langScore, detectQuality
};
