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

// Řadové číslovky a římská čísla → číslice, aby "Druhá světová válka" = "2.světová válka";
// stejná slova v různém zápisu: "Ford vs Ferrari" = "Ford v Ferrari", "Doktor House" = "Dr. House"
const ORDINALS = { prvni: '1', druha: '2', druhy: '2', druhe: '2', treti: '3', ctvrta: '4', ctvrty: '4', ii: '2', iii: '3',
    vs: 'v', versus: 'v', doktor: 'dr', doctor: 'dr' };

function tokens(str) {
    const n = normalize(str);
    return n ? fiveO(n.split(' ').map(t => ORDINALS[t] || t)) : [];
}
// "Hawaii 5-0" = "5-O" = "5 O" = "Five-0" = "Five-O" → "5 0"
function fiveO(t) {
    for (let i = 0; i + 1 < t.length; i++) {
        if ((t[i] === '5' || t[i] === 'five') && (t[i + 1] === 'o' || t[i + 1] === '0')) { t[i] = '5'; t[i + 1] = '0'; }
    }
    return t;
}
// Tokeny se zachovanou velikostí písmen, zarovnané s tokens() (pro zkratky jako "NCIS LA")
function rawTokens(str) {
    const n = String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ').replace(/['’`´]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
    return n ? n.split(' ') : [];
}

// Skupiny v hranatých závorkách na začátku ("[SubsPlease] ", "[DB]") – pro porovnání názvu se odstraní,
// jinak by jednoslovný název nebyl první ("[DB]Working!!_-_01")
// "[Nekomoe kissaten][Chii Fuyo][01][1080p]" → "Chii Fuyo [01][1080p]" (závorka před číslem dílu je název)
function stripLeadingGroups(fileName) {
    let s = String(fileName || '');
    const re = /^\s*\[([^\]]*)\]\s*[-_.]*\s*/;
    let m;
    while ((m = s.match(re))) {
        const rest = s.slice(m[0].length);
        if (/[a-z]{2}/i.test(m[1]) && /^\[\s*\d{1,4}(?:v\d)?(?:\s*end)?\s*\]/i.test(rest)) return `${m[1].trim()} ${rest}`;
        s = rest;
    }
    return s;
}
function fileTokens(fileName) {
    return tokens(stripLeadingGroups(fileName));
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
        .replace(/[:!?*\/\\"„“’‘´`]/g, ' ')   // typografický apostrof ("Sex O’Clock") → mezera
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
// - víceslovný název musí být na začátku; před ním smí stát jen číslo/značka dílu/rok
//   nebo jiný náš název (CZ "Válka ve Vietnamu - The Vietnam War"), jinak by
//   "Inside the Vietnam War" / "Turning Point The Vietnam War" sedělo na "The Vietnam War"
function titleMatches(fileName, name, others) {
    const ft = fileTokens(fileName);
    const nt = nameTokens(name);
    if (!nt.length || !ft.length) return false;
    const set = new Set(ft);
    if (!nt.every(t => set.has(t))) return false;
    if (nt.length === 1) {
        const sig = ft.filter(t => !STOPWORDS.has(t));
        const idx = sig.indexOf(nt[0]);
        if (idx === 0) return true;
        const next = sig[idx + 1];
        if (idx > 0 && PREFIX_BAD.has(sig[idx - 1])) return false;   // "Lego Batman 2022"
        // před názvem jen číslo / značka dílu a soubor má značku dílu ("2 Reacher CZ S01E02")
        if (idx > 0 && sig.slice(0, idx).every(t => PREFIX_OK.test(t)) && looksLikeEpisode(fileName)) return true;
        return !!next && /^(19|20)\d{2}$/.test(next);
    }
    // víceslovný název: slova musí jít za sebou ve stejném pořadí (mezery do 3 slov),
    // jinak by "… World 2" sedělo na "… World … Opus 2.0"
    const hit = afterName(fileName, name);
    if (!hit) return false;
    if (hit.start === 0) return true;
    const prefix = ft.filter(t => !STOPWORDS.has(t)).slice(0, hit.start);
    const words = prefix.filter(t => !PREFIX_OK.test(t) && !ROMAN_ANY.test(t) && !PREFIX_NOISE.has(t));
    if (!words.length) return true;
    // jedno slovo před názvem ("Batman 5 Temný rytíř", "HNS_Rokudenashi…") – kromě dokumentárních
    if (words.length === 1 && !PREFIX_BAD.has(words[0])) return true;
    // název oddělený pomlčkou ("Filmy od LM --- Temný rytíř povstal")
    const raw = stripLeadingGroups(fileName);
    const re = /\s+[-–—]+\s+|-{2,}|_-_|\s+\|\s+/g;
    let m;
    while ((m = re.exec(raw))) {
        const h = afterName(raw.slice(m.index + m[0].length), name);
        if (h && h.start === 0) return true;
    }
    // před názvem jiný náš název (CZ "Válka ve Vietnamu The Vietnam War")
    const pre = prefix.join(' ');
    return (others || []).some(o => {
        if (!o || o === name) return false;
        const h = afterName(pre, o);
        return !!h && h.start === 0;
    });
}
// slova před názvem, která se nepočítají (poznámky uploaderů, přípona kanálu): "Novinka_fv_…", "Horror MKV-…"
const PREFIX_NOISE = new Set(['novinka', 'novinky', 'fv', 'mkv', 'avi', 'mp4']);
// slova, která smí stát před názvem: číslo, značka dílu, rok, římská číslice
const PREFIX_OK = /^(\d{1,4}|s\d{1,2}(e\d{1,4})?|e\d{1,4}|ep\d{0,4}|\d{1,2}x\d{1,4})$/;
const ROMAN_ANY = /^(i{1,3}|iv|v|vi{1,3}|ix|x)$/;
// slova před názvem, která značí jiný (dokumentární/odvozený) titul: "Inside the Vietnam War", "Lego Batman"
const PREFIX_BAD = new Set(('inside behind making becoming beyond lego untold secret secrets return revisiting remembering ' +
    'uncovering unmasking reliving decoding history story truth road after before ultimate complete official unofficial ' +
    'tribute parody honest pitch skutecna skutecny skutecne real true').split(' '));

// Roky v názvu souboru (1920–2035)
function fileYears(fileName, { noRanges = false } = {}) {
    const out = [];
    // ne rozlišení (1920x1080) ani CRC v hranatých závorkách ([1989E8F0])
    const re = /(?:^|[^0-9x])((?:19|20)\d{2})(?![0-9]|p\b|x\d)/gi;
    let m;
    let s = String(fileName).replace(/\[[0-9A-F]{8}\]/gi, ' ');
    // rozsah let ("1858 - 1961", "2004-2005") = období děje / vysílání, ne rok vydání
    if (noRanges) s = s.replace(/(?<![0-9])[12]\d{3}\s*[-–]\s*[12]\d{3}(?![0-9])/g, ' ');
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
function parseEpisode(fileName, excludeTokens, restTokens) {
    let n = normalize(fileName);
    let season = null, episode = null, explicit = false;

    // S01E05, S1 E5, S01.E05, S01-E05
    let m = n.match(/\bs\s?(\d{1,2})\s?e\s?(\d{1,4})\b/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };
    // S01E05 slepené s dalším textem (např. "s01e05v2")
    m = n.match(/s(\d{1,2})e(\d{1,4})(?![0-9])/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };
    // [1.04] / (1.04) – sezóna.díl v závorce
    m = String(fileName).match(/[\[(]\s*(\d{1,2})\.(\d{2,3})\s*[\])]/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };
    // 1x05, 5x7 (Hellspy často bez nuly)
    m = n.match(/\b(\d{1,2})x(\d{1,4})\b/);
    if (m) return { season: +m[1], episode: +m[2], explicit: true };
    // 01E06 – sezóna a díl bez "S" ("Na seznamu smrti 01E06")
    m = n.match(/\b(\d{2})e(\d{2,3})\b/);
    if (m && +m[1] > 0) return { season: +m[1], episode: +m[2], explicit: true };

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

    // Holé číslo hned za názvem (název je z hledání vyřazený, takže "Mob Psycho 100" ani "2.světová" nepřekáží)
    if (Array.isArray(restTokens)) {
        const restNums = stripTech(restTokens.join(' ')).split(' ').filter(t => /^\d{1,4}$/.test(t));
        if (season !== null) {
            const i = restNums.findIndex(t => +t === season);
            if (i !== -1 && restNums.length > 1) restNums.splice(i, 1);
        }
        if (restNums.length) return { season, episode: +restNums[0], explicit: false };
        m = restTokens.join(' ').match(/\b(\d{1,4})v\d\b/);
        return { season, episode: m ? +m[1] : null, explicit: false };
    }
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
        /\b\d{1,2}x\d{1,3}\b/.test(n) || /\b(?:ep|episode|epizoda)\s?\d{1,4}\b/.test(n) ||
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
    const cam = /\s(cam|camrip|hdcam|ts|telesync|tc|hdts|hdtc|telecine|tsrip)\s/.test(n);
    if (cam) score = -1;
    const codec = /\s(hevc|x265|h265)\s/.test(n) ? 'HEVC' : /\s(x264|h264|avc)\s/.test(n) ? 'H.264' : /\sav1\s/.test(n) ? 'AV1' : null;
    const audio = /\s(truehd|atmos)\s/.test(n) ? 'TrueHD' : /\sdts\s/.test(n) ? 'DTS' : /\s(eac3|ddp)\s/.test(n) ? 'DD+' : /\s(ac3|dd)\s/.test(n) ? 'AC3' : /\saac\s/.test(n) ? 'AAC' : null;
    const hdr = /\s(hdr|hdr10|dv|dolby vision)\s/.test(n);
    const source = /\sremux\s/.test(n) ? 'REMUX' : /\s(bluray|bdrip|brrip|bd)\s/.test(n) ? 'BluRay' : /\s(web dl|webdl|webrip|web)\s/.test(n) ? 'WEB' : /\s(dvdrip|dvd)\s/.test(n) ? 'DVD' : /\shdtv\s/.test(n) ? 'HDTV' : null;
    return { resolution, score, codec, audio, hdr, source, cam };
}

// Slova, která za názvem v souboru nevadí (jazyk, kvalita, zdroj, verze …)
const TECH_WORDS = new Set(('cz cze czech cesky sk svk slovak en eng english jap jpn japanese cc multi dual dab dabing dabbing dub dubbed ' +
    'tit titulky sub subs forced hd fhd uhd sd bluray bdrip brrip bd remux webrip web dl webdl hdtv dvdrip dvd rip ' +
    'xvid divx hevc avc aac ac3 dts ddp truehd atmos hdr dv extended edition directors cut uncut unrated remastered ' +
    'complete kompletni serie series season sezona rada episode ep epizoda dil cast part mp4 mkv avi vostfr ' +
    'tv ova movie film proper repack internal limited anime capitulo episodio folge odcinek bolum aflevering ' +
    'kvalita dobra pekna prodlouzena rozsirena mpg mpeg wmv ts mov flv m4v webm').split(' '));

// Najde v souboru slova názvu (v pořadí, mezery mezi nimi tolerované – "Rosario to Vampire" ~ "Rosario + Vampire");
// vrací pozici prvního slova a slova, která následují za posledním.
// Člen/spojka (the, of…) v mezeře mezi slovy, který v názvu na tom místě není, shodu ruší:
// "Vietnam The War That Changed America" ≠ "The Vietnam War"
function afterName(fileName, name) {
    const all = fileTokens(fileName);
    const pos2all = [];
    all.forEach((t, i) => { if (!STOPWORDS.has(t)) pos2all.push(i); });
    const ft = pos2all.map(i => all[i]);
    const nt = nameTokens(name);
    if (!nt.length) return null;
    // členy názvu mezi jeho významnými slovy: gaps[j] = členy mezi nt[j-1] a nt[j]
    const nAll = tokens(name);
    const gaps = [];
    if (nt.length < nAll.length && nAll.some(t => !STOPWORDS.has(t))) {
        let j = -1, cur = [];
        for (const t of nAll) {
            if (STOPWORDS.has(t)) { cur.push(t); continue; }
            if (j >= 0) gaps[j + 1] = cur;
            j++; cur = [];
        }
    }
    const checkStops = nAll.some(t => !STOPWORDS.has(t));
    const nStops = new Set(nAll.filter(t => STOPWORDS.has(t)));
    for (let i = 0; i < ft.length; i++) {
        if (ft[i] !== nt[0]) continue;
        let pos = i, ok = true;
        for (let j = 1; j < nt.length; j++) {
            const k = ft.indexOf(nt[j], pos + 1);
            if (k === -1 || k - pos > 3) { ok = false; break; }
            if (checkStops) {
                // člen, který v názvu je, ale jinde ("Vietnam The War" × "The Vietnam War"); chybějící/navíc "a" nevadí
                const allowed = gaps[j] || [];
                const extra = all.slice(pos2all[pos] + 1, pos2all[k]).filter(t => STOPWORDS.has(t));
                if (extra.some(t => !allowed.includes(t) && nStops.has(t))) { ok = false; break; }
            }
            pos = k;
        }
        if (ok) return { start: i, rest: ft.slice(pos + 1), endAll: pos2all[pos] };
    }
    return null;
}

// Podtitul za dvojtečkou ("Druhá světová válka: Cena říše" → "Cena říše") – soubory se tak často jmenují
function subTitle(str) {
    const parts = String(str || '').split(/\s*:\s+|\s+[-–—]\s+/);
    if (parts.length < 2) return null;
    const sub = parts.slice(1).join(' ').trim();
    const nt = nameTokens(sub);
    if (nt.length < 2 || !nt.some(t => t.length >= 4)) return null;
    if (/^(season|part|serie|series|rada|cast|the movie|movie|film)\b/i.test(normalize(sub))) return null;
    return sub;
}

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };
// Značka pokračování hned za názvem ("Capu2", "II", "2nd season", "S2", "Název 2 - 05") → číslo sezóny
function sequelSeason(rest) {
    const a = rest && rest[0], b = rest && rest[1];
    if (!a) return null;
    if (ROMAN[a]) return ROMAN[a];
    let m = a.match(/^s(\d)$/) || a.match(/^(\d)(?:st|nd|rd|th)$/) || a.match(/^[a-z]{2,}([2-9])$/);
    if (m) return +m[1];
    if (/^[2-9]$/.test(a) && b && /^\d{1,4}$/.test(b)) return +a;
    return null;
}

// Zkrácený název ("Druhá světová válka" z "Druhá světová válka: Cena říše") je šum,
// když v souboru nezačíná (do 2. slova) nebo za ním stojí jiný podtitul ("… v barvách", "… Na frontě")
function shortNameIsNoise(fileName, shortName, fullName) {
    const hit = afterName(fileName, shortName);
    if (!hit || hit.start > 1) return true;
    const full = new Set(nameTokens(fullName));
    const next = hit.rest.find(t => !(t.length < 2 && /^[a-z]$/.test(t)));
    if (!next) return false;
    if (!/^[a-z]+$/.test(next)) return false;          // číslo, S02E05, 1080p, 2nd …
    if (full.has(next) || TECH_WORDS.has(next) || ROMAN[next]) return false;
    return true;
}

// Soubory, které nejdou přehrát: archivy, titulky, obrázky, hudba, dokumenty…
const NON_VIDEO = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|img|r\d{2}|\d{3}|srt|ass|ssa|sub|idx|vtt|sup|smi|nfo|txt|doc|docx|pdf|jpg|jpeg|png|gif|webp|bmp|exe|apk|msi|torrent|mp3|flac|m4a|m4b|mka|aax|aac|ogg|opus|wav|wma)$/i;
function isNonVideo(fileName) {
    return NON_VIDEO.test(String(fileName || '').trim());
}

// Slova, kterými v názvu souboru začíná popis, ne název (žánry, poznámky uploaderů)
const DESC_WORDS = new Set(('akcni akcia akcny krimi drama thriller scifi sci fi fantasy horor horror komedie komedia ' +
    'rodinny animovany animak dobrodruzny valecny western dokument dokumentarni romanticky mysteriozni zivotopisny ' +
    'hudebni historicky psychologicky erotic novinky novinka novinkа kino kinorip kinoverze csfd imdb hodnoceni by from ' +
    'upload uploaded rip tvrip hdrip dvdscr screener dvbt dvb koukatelne verze verzia rezie usa uk cr sr').split(' '));

// Jiný podtitul za názvem = jiné dílo ("Batman se vrací", "Temný rytíř povstal", "House of the Dragon").
// Za názvem smí být jen: slova z našich názvů (allow), čísla, technické údaje, žánry/popisy, římská čísla.
// Otevírací závorka = konec názvu (dál bývají herci, žánry, rok: "(Christian Bale, …)", "-(akcni)-", "(S03E05)").
// Kontrola končí u roku, technického údaje, popisu nebo značky dílu (S01E01, E05, 1x05).
// mode 'series': číslo (díl) kontrolu ukončí a slova do 2 znaků se přeskakují ("House MD", "Gantz - 09 - Kill It")
function subtitleNoise(fileName, name, allow, mode) {
    const cleaned = stripLeadingGroups(fileName).replace(/[([{]/g, ' qqstopqq ');
    const hit = afterName(cleaned, name);
    if (!hit) return false;
    const series = mode === 'series';
    const rest6 = hit.rest.slice(0, 6);
    for (let i = 0; i < rest6.length; i++) {
        const t = rest6[i];
        if (t === 'qqstopqq' || /^(19|20)\d{2}$/.test(t)) return false;              // závorka / rok
        if (t === 'full' && /^(hd|fhd|uhd|bd|hdrip|\d{3,4}p)$/.test(rest6[i + 1] || '')) return false;   // "Full HD" (ne "Full Gate!")
        if (TECH_WORDS.has(t) || DESC_WORDS.has(t) || /^\d{3,4}[pi]$/.test(t) || /^[xh]26[45]$/.test(t)) return false;
        if (/^(cz|cze|sk|en|eng)+(dab|dabing|tit|titulky|sub|subs|audio)?$/.test(t)) return false;  // "CZdab", "CZEN", "CZSKEN"
        if (/^s\d{1,2}(e\d{1,4})?$/.test(t) || /^e\d{1,4}$/.test(t) || /^\d{1,2}x\d{1,4}$/.test(t) || /^ep\d*$/.test(t)) return false;
        if (/^\d+$/.test(t)) { if (series) return false; continue; }                  // film: "Pán prstenů 1 …"
        if (t.length < 2 || (series && t.length <= 2)) continue;
        if (ROMAN[t] || (allow && allow.has(t))) continue;
        if (!/^[a-z]+$/.test(t)) return false;                                         // 1080p, 05v2 …
        return true;                                                                   // cizí slovo → jiné dílo
    }
    return false;
}

// Zkratka spin-offu hned za názvem = jiný titul ("NCIS LA", "CSI NY", "Law & Order SVU");
// jen známé zkratky – obecná pravidla by brala i "House MD" apod.
const SPINOFF_ABBR = new Set(['la', 'ny', 'nola', 'svu', 'ci', 'dc', 'miami', 'cyber', 'vegas']);
function spinoffAbbrev(fileName, name, allow) {
    const clean = stripLeadingGroups(fileName);
    const hit = afterName(clean, name);
    if (!hit) return false;
    const raw = rawTokens(clean);
    const t = raw[hit.endAll + 1];
    if (!t) return false;
    const l = t.toLowerCase();
    if (!SPINOFF_ABBR.has(l) || (allow && allow.has(l))) return false;
    // dvoupísmenné jen velkými písmeny ("NCIS LA", ne "la" jako člen)
    return l.length > 2 ? true : /^[A-Z]+$/.test(t);
}

// Číslo dílu filmové série hned u názvu: "Rambo 2", "RAMBO-3", "Rambo III", "Rambo IV", "4.Rambo.Do.pekla" → číslo;
// "Rambo 5.1 CZ" (zvuk), rok, rozlišení se neberou
const PART_ROMAN = { iv: 4, vi: 6, vii: 7, viii: 8, ix: 9 };   // ii/iii převádí tokens() na 2/3; samotné v/x ne (předložka, „Malcolm X“)
function partNumber(fileName, name) {
    const hit = afterName(fileName, name);
    if (!hit) return null;
    const raw = stripLeadingGroups(fileName);
    const num = (t, nxt) => {
        if (!t) return null;
        if (/^\d{1,2}$/.test(t) && +t >= 1 && +t <= 20) {
            if (nxt && /^\d$/.test(nxt) && new RegExp(`(?:^|[^0-9])${t}[.,]${nxt}(?![0-9])`).test(raw)) return null;   // 5.1
            return +t;
        }
        return PART_ROMAN[t] || null;
    };
    const after = num(hit.rest[0], hit.rest[1]);
    if (after !== null) return after;
    if (hit.start > 0) {
        const all = fileTokens(fileName).filter(t => !STOPWORDS.has(t));
        const before = all[hit.start - 1];
        if (hit.start === 1 && /^\d{1,2}$/.test(before) && +before >= 1 && +before <= 20) return +before;   // "4.Rambo…"
    }
    return null;
}
// Obsahuje náš název číslo / římskou číslici (pak se pořadí v sérii nekontroluje – "Star Wars: Epizoda IV")
function hasPartNumber(name) {
    return tokens(name).some(t => (/^\d{1,2}$/.test(t)) || PART_ROMAN[t]);
}

// Roky v názvu dílu: za značkou dílu (S10E1 / 10x01) a hned za slovem z našeho názvu
// ("Archer - S10E1 Archer 1999: Bort the Garj" → 1999); "Most S01E02 HD 2011" se nepočítá (před rokem "hd")
function episodeTitleYears(fileName, nameWords) {
    const ft = normalize(stripLeadingGroups(fileName)).split(' ').filter(Boolean);
    const mk = ft.findIndex(t => /^s\d{1,2}e\d{1,4}$/.test(t) || /^\d{1,2}x\d{1,4}$/.test(t));
    if (mk < 0) return [];
    const out = [];
    for (let i = mk + 2; i < ft.length; i++) {
        if (/^(19|20)\d{2}$/.test(ft[i]) && nameWords.has(ft[i - 1])) out.push(+ft[i]);
    }
    return out;
}

// Zkomolený název proti mazání ("The Simps.ons S35E03", "Simpsnovi S35E03", "M.o.b.land S01E02",
// "1Země gangů_S01E01"): u seriálu se přesnou značkou hledaného dílu porovná text před značkou
// bez mezer/teček s názvem. Shoda = rozdělené slovo; u názvů od 9 znaků i jedno písmeno navíc/chybí/jiné
// (stejné začátek a číslice). Vrací { name, text } – opravený název souboru pro běžné posouzení – nebo null.
function levOne(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
function repairName(fileName, names, season, episode, { anime = false, alEpisode = null } = {}) {
    const raw = stripLeadingGroups(fileName);
    const ft = normalize(raw).split(' ').filter(Boolean);
    let mk = -1, mkLen = 1;
    for (let i = 0; i < ft.length && mk < 0; i++) {
        let m = ft[i].match(/^s(\d{1,2})e(\d{1,3})$/) || ft[i].match(/^(\d{1,2})x(\d{1,3})$/);
        let len = 1;
        if (!m && /^s\d{1,2}$/.test(ft[i]) && /^e\d{1,3}$/.test(ft[i + 1] || '')) {
            m = [null, ft[i].slice(1), ft[i + 1].slice(1)]; len = 2;
        }
        if (m && +m[1] === season && +m[2] === episode) { mk = i; mkLen = len; }
    }
    if (mk < 0 && anime) return repairAbsolute(raw, names, [episode, alEpisode]);
    if (mk < 1 || mk > 8) return null;
    const head = ft.slice(0, mk);
    const years = [];
    while (head.length > 1 && /^(19|20)\d{2}$/.test(head[head.length - 1])) years.unshift(head.pop());
    // číslo dílu přilepené před názvem ("1Země gangů")
    const g = head[0].match(/^0*(\d{1,3})([a-z].*)$/);
    if (g && +g[1] === episode) head[0] = g[2];
    const compact = head.join('');
    const digits = s => s.replace(/[^0-9]/g, '');
    for (const name of names) {
        const nc = tokens(name).join('');
        if (nc.length < 4) continue;
        const same = compact === nc;
        const near = !same && nc.length >= 9 && compact.slice(0, 3) === nc.slice(0, 3) &&
            digits(compact) === digits(nc) && levOne(compact, nc);
        // jediná záměna c↔k nebo w↔v i u kratších názvů ("Cobra 11" = "Kobra 11")
        const ck = t => t.replace(/c/g, 'k').replace(/w/g, 'v');
        const swap = !same && !near && nc.length >= 5 && compact.length === nc.length &&
            compact !== nc && ck(compact) === ck(nc) && levOne(compact, nc);
        if (!same && !near && !swap) continue;
        const text = [name, ...years, ...ft.slice(mk)].join(' ');
        return { name, text, how: same ? 'spojený' : 'překlep' };
    }
    return null;
}

// Anime s absolutním číslem ("[YE] … Uchuusen-mochi datta node, Ikkodate … - 02 (BS11 …)"): text před " - 02"
// bez mezer/pomlček musí přesně odpovídat některému názvu (aspoň 15 písmen); zkrácené názvy neprojdou
function repairAbsolute(raw, names, eps) {
    const re = /\s[-–]\s*0*(\d{1,4})(?:v\d)?(?=[\s\[\(._]|$)/g;
    let m;
    while ((m = re.exec(raw))) {
        const ep = +m[1];
        if (!eps.includes(ep)) continue;
        const compact = tokens(raw.slice(0, m.index)).join('');
        for (const name of names) {
            const nc = tokens(name).join('');
            if (nc.length < 15 || compact !== nc) continue;
            return { name, text: `${name} - ${m[1]}${raw.slice(m.index + m[0].length)}`, how: 'spojený' };
        }
    }
    return null;
}

module.exports = {
    repairName, episodeTitleYears, partNumber, hasPartNumber,
    spinoffAbbrev, rawTokens,
    stripLeadingGroups, subtitleNoise,
    isNonVideo, afterName, sequelSeason, shortNameIsNoise, subTitle,
    normalize, tokens, nameTokens, queryText, isLatin, shortTitle,
    titleMatches, fileYears, parseEpisode, looksLikeEpisode,
    detectLang, langScore, detectQuality
};
