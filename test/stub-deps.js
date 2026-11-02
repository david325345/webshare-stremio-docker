// Bez node_modules (např. noční kontrola, kde nejde npm): express a needle nahradí prázdné náhrady.
// Test parseru (judgeFile, durationMismatch …) je nepotřebuje – server.js je jen načítá při startu.
// Když jsou balíčky nainstalované, použijí se skutečné a tento soubor nic nemění.
const Module = require('module');

function stub() {
    const fn = function () { return proxy; };
    const proxy = new Proxy(fn, {
        get: (t, k) => k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : proxy,
        apply: () => proxy,
        construct: () => proxy
    });
    return proxy;
}

const STUBBED = new Set(['express', 'needle']);
const announced = new Set();
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    try {
        return resolve.call(this, request, parent, ...rest);
    } catch (e) {
        if (!STUBBED.has(request)) throw e;
        const id = `/__stub__/${request}`;
        if (!require.cache[id]) {
            const m = new Module(id);
            m.filename = id;
            m.loaded = true;
            m.exports = stub();
            require.cache[id] = m;
        }
        if (!announced.has(request)) {
            announced.add(request);
            console.error(`(${request} není nainstalovaný – použita prázdná náhrada, test parseru ho nepotřebuje)`);
        }
        return id;
    }
};
