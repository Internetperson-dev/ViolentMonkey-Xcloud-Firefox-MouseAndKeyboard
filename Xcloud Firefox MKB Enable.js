// ==UserScript==
// @name         Xcloud Firefox MKB Enable
// @namespace    http://tampermonkey.net/
// @version      5.3
// @description  xcloud MKB on Firefox: navigator.keyboard polyfill, targeted pointer-lock keep-alive, chord-click tracing + movement-delta fix
// @match        *://*.play.xbox.com/*
// @match        *://*.xbox.com/en-GB/play*
// @match        *://assets.play.xbox.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  v5.2
  Symptom: view moves when LEFT is pressed while RIGHT is held.
  Hypothesis: Firefox fires a pointermove/mousemove for the button change that
  carries a non-zero movementX/Y (stray or duplicated delta) which xCloud counts
  as real motion.

  Console helpers (press Esc / alt-tab to reach the console, then click back
  into the stream to re-lock):
      __mkb.dumpChords()        events around every button change (paste this)
      __mkb.stats()             delta summary: button-change moves vs normal moves
      __mkb.dumpEvents()        keys, buttons, lock and focus events only (no mouse moves)
      __mkb.dump(80)            last 80 raw events
      copy(__mkb.text())        copy the last 300 events to the clipboard
      __mkb.clear()             empty the trace buffer

  Experiment toggles:
      __mkb.zeroChordDelta = true   zero movementX/Y on button-change moves
      __mkb.chord = true            synthesize missing pointerdown/up (v5.1 shim)
      __mkb.blockExit = false       disable pointer-lock keep-alive
*/

(function () {
    'use strict';

    const cfg = window.__mkb = {
        blockExit: true,
        chord: false,           // synthetic pointerdown/up - off, not needed
        chordMouse: false,      // synthetic mousedown/up - off
        zeroChordDelta: true,   // the movement fix
        blockContextMenu: true, // stop right-click menu from stealing focus/keys
        trace: true,
        debug: false
    };

    // ---- 1. navigator.keyboard polyfill -----------------------------------
    if (!('keyboard' in navigator)) {
        const layoutMap = new Map();
        layoutMap.get = (k) => (typeof k === 'string' ? k : 'us');
        layoutMap.has = () => true;
        const kb = {
            getLayoutMap: () => Promise.resolve(layoutMap),
            lock: () => Promise.resolve(true),
            unlock: () => Promise.resolve(true)
        };
        try {
            Object.defineProperty(Navigator.prototype, 'keyboard', { get: () => kb, configurable: true });
        } catch (e) {
            try { Object.defineProperty(navigator, 'keyboard', { get: () => kb, configurable: true }); } catch (_) {}
        }
    }

    // ---- 2. Targeted pointer-lock keep-alive ------------------------------
    const shouldBlock = () =>
        cfg.blockExit && !!document.pointerLockElement && !document.fullscreenElement;

    const guard = (proto, name) => {
        if (!proto || typeof proto[name] !== 'function') return;
        const real = proto[name];
        proto[name] = function (...args) {
            if (shouldBlock()) {
                if (cfg.debug) console.warn('[Xcloud MKB] blocked ' + name + '()');
                return;
            }
            return real.apply(this, args);
        };
    };
    guard(Document.prototype, 'exitPointerLock');
    guard(Document.prototype, 'webkitExitPointerLock');

    // ---- 3. Trace buffer + movement-delta fix -----------------------------
    const MOVE = ['pointermove', 'mousemove', 'pointerrawupdate'];
    const BTN = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'click', 'auxclick'];
    const T0 = performance.now();
    const MAX = 600;
    const buf = [];
    const lastBtn = { pointermove: 0, mousemove: 0, pointerrawupdate: 0 };
    const lastDelta = {};

    const now = () => Math.round(performance.now() - T0);
    const push = (r) => { buf.push(r); if (buf.length > MAX) buf.shift(); };

    const onMove = (e) => {
        if (!e.isTrusted) return;
        const changed = e.buttons !== lastBtn[e.type];
        lastBtn[e.type] = e.buttons;

        const mx = e.movementX, my = e.movementY;
        const pd = lastDelta[e.type];
        const dup = !!pd && (mx !== 0 || my !== 0) && pd[0] === mx && pd[1] === my;
        lastDelta[e.type] = [mx, my];

        let zeroed = false;
        if (cfg.zeroChordDelta && changed && (mx !== 0 || my !== 0)) {
            try {
                Object.defineProperty(e, 'movementX', { value: 0 });
                Object.defineProperty(e, 'movementY', { value: 0 });
                zeroed = true;
            } catch (_) {}
        }

        if (cfg.trace) push({ t: now(), type: e.type, b: e.buttons, mx, my, changed, dup, zeroed, flag: changed });
    };

    const onBtn = (e) => {
        if (!e.isTrusted) return;
        if (e.type.endsWith('down') || e.type.endsWith('up')) {
            for (const k of MOVE) lastBtn[k] = e.buttons;
        }
        if (cfg.trace) push({ t: now(), type: e.type, b: e.buttons, button: e.button, flag: true });
    };

    const keysDown = new Set();
    const onKey = (e) => {
        if (e.type === 'keydown') {
            if (e.repeat) return;
            keysDown.add(e.code);
        } else {
            keysDown.delete(e.code);
        }
        if (cfg.trace) push({ t: now(), type: e.type, key: e.code, held: [...keysDown].join('+'), trusted: e.isTrusted, flag: true });
    };
    ['keydown', 'keyup'].forEach(t => addEventListener(t, onKey, true));
    ['blur', 'focus'].forEach(t => addEventListener(t, (e) => {
        if (e.target === window || e.target === document) {
            if (cfg.trace) push({ t: now(), type: t.toUpperCase(), flag: true });
        }
    }, true));
    addEventListener('contextmenu', (e) => { if (cfg.blockContextMenu) e.preventDefault(); }, true);

    MOVE.forEach(t => addEventListener(t, onMove, true));
    BTN.forEach(t => addEventListener(t, onBtn, true));
    addEventListener('blur', () => { for (const k of MOVE) lastBtn[k] = 0; }, true);
    document.addEventListener('pointerlockchange', () => {
        if (cfg.trace) push({ t: now(), type: 'LOCK ' + (document.pointerLockElement ? 'locked' : 'UNLOCKED'), flag: true });
    });

    const fmt = (r) =>
        String(r.t).padStart(6) + ' ' + r.type.padEnd(16) +
        (r.b !== undefined ? ' b=' + r.b : '') +
        (r.mx !== undefined ? ' d=(' + r.mx + ',' + r.my + ')' : '') +
        (r.button !== undefined ? ' button=' + r.button : '') +
        (r.key !== undefined ? ' key=' + r.key + ' held=[' + r.held + ']' + (r.trusted === false ? ' SYNTHETIC' : '') : '') +
        (r.changed ? '  <CHANGE' : '') +
        (r.dup ? '  <DUP-DELTA' : '') +
        (r.zeroed ? '  <ZEROED' : '');

    // Only move events with a button change, plus neighbors, grouped by gaps.
    cfg.dumpChords = (around = 3) => {
        const keep = new Set();
        buf.forEach((r, i) => {
            if (r.flag) for (let j = i - around; j <= i + around; j++) if (j >= 0 && j < buf.length) keep.add(j);
        });
        const out = [];
        let prev = -2;
        [...keep].sort((a, b) => a - b).forEach(i => {
            if (i !== prev + 1) out.push('---');
            out.push(fmt(buf[i]));
            prev = i;
        });
        console.log(out.join('\n'));
    };

    cfg.dumpEvents = (n = 120) => console.log(
        buf.filter(r => !MOVE.includes(r.type)).slice(-n).map(fmt).join('\n'));

    cfg.dump = (n = 80) => console.log(buf.slice(-n).map(fmt).join('\n'));
    cfg.text = (n = 300) => buf.slice(-n).map(fmt).join('\n');
    cfg.clear = () => { buf.length = 0; };

    cfg.stats = () => {
        const summarize = (rows) => {
            const mags = rows.map(r => Math.abs(r.mx) + Math.abs(r.my));
            return {
                count: rows.length,
                nonZero: mags.filter(m => m > 0).length,
                dupDelta: rows.filter(r => r.dup).length,
                meanAbs: mags.length ? +(mags.reduce((a, b) => a + b, 0) / mags.length).toFixed(2) : 0,
                maxAbs: mags.length ? Math.max(...mags) : 0
            };
        };
        const out = {};
        for (const type of ['pointermove', 'mousemove']) {
            const rows = buf.filter(r => r.type === type);
            out[type + ' (button change)'] = summarize(rows.filter(r => r.changed));
            out[type + ' (normal)'] = summarize(rows.filter(r => !r.changed));
        }
        console.table(out);
        return out;
    };

    // ---- 4. Optional chord shim (v5.1) ------------------------------------
    const BIT_TO_BUTTON = { 1: 0, 4: 1, 2: 2, 8: 3, 16: 4 };
    let prev = 0;
    const sync = (e) => { if (e.isTrusted) prev = e.buttons; };
    addEventListener('pointerdown', sync, true);
    addEventListener('pointerup', sync, true);
    addEventListener('pointercancel', () => { prev = 0; }, true);
    addEventListener('blur', () => { prev = 0; }, true);

    addEventListener('pointermove', (e) => {
        if (!cfg.chord || !e.isTrusted || e.buttons === prev) return;
        const diff = e.buttons ^ prev;
        prev = e.buttons;
        const target = document.pointerLockElement || e.target;
        for (const bit of [1, 2, 4, 8, 16]) {
            if (!(diff & bit)) continue;
            const down = !!(e.buttons & bit);
            const init = {
                bubbles: true, cancelable: true, composed: true, view: window,
                button: BIT_TO_BUTTON[bit], buttons: e.buttons,
                clientX: e.clientX, clientY: e.clientY,
                screenX: e.screenX, screenY: e.screenY
            };
            target.dispatchEvent(new PointerEvent(down ? 'pointerdown' : 'pointerup', {
                ...init, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary
            }));
            if (cfg.chordMouse) target.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', init));
        }
    }, true);

    // ---- 5. Diagnostics ---------------------------------------------------
    window.__xcloudMKB = () => ({
        keyboardSupported: !!navigator.keyboard,
        isFullscreen: !!document.fullscreenElement,
        pointerLock: document.pointerLockElement?.tagName ?? null,
        config: { ...cfg }
    });
    const report = () => console.info('[Xcloud MKB v5.3]', JSON.stringify(window.__xcloudMKB()));
    addEventListener('pointerlockchange', report);
    addEventListener('fullscreenchange', report);
    setTimeout(report, 1500);
})();
