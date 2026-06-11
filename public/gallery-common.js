'use strict';

// =====================================================================
// Shared gallery helpers — card factory, URL builder, lazy loading,
// state persisted in localStorage so settings survive page nav.
//
// The gallery is a no-relay preview surface: each card is an iframe that
// loads the real display (`/?scenario=…`) or controller
// (`/controller/index.html?scenario=…`) page so the page's TestHarness drives a
// single screen without ever touching the relay. UI regressions show up here.
// =====================================================================

var Gallery = (function() {
  // Car livery palette names, indexed to match protocol.js CAR_COLORS.
  var PLAYER_COLOR_NAMES = ['red', 'amber', 'green', 'blue', 'purple', 'pink', 'orange', 'cyan'];

  var DISPLAY_AR_DIMS = {
    '16x9': { w: 1920, h: 1080 },
    '21x9': { w: 2560, h: 1080 },
    '4x3':  { w: 1600, h: 1200 },
    '1x1':  { w: 1200, h: 1200 }
  };

  // Controller preview devices. Dimensions are CSS pixels in the device's
  // native portrait orientation. Orientation + browser-chrome toggles in the
  // UI derive the final iframe dims from these base values.
  var CONTROLLER_DEVICES = [
    { id: 'iphone15pm', label: 'iPhone 15 Pro Max', w: 430, h: 932 },
    { id: 'iphone14',   label: 'iPhone 14',         w: 390, h: 844 },
    { id: 'iphonese',   label: 'iPhone SE (3rd)',   w: 375, h: 667 },
    { id: 'pixel8',     label: 'Pixel 8',           w: 412, h: 915 },
    { id: 'galaxys23',  label: 'Galaxy S23',        w: 360, h: 780 },
    { id: 'zfoldcover', label: 'Galaxy Z Fold cover', w: 280, h: 653 }
  ];
  // Approximate visible browser chrome (address bar + system UI) that steals
  // viewport height when the page is not in fullscreen mode.
  var BROWSER_CHROME = { portrait: 120, landscape: 48 };

  function findDevice(id) {
    for (var i = 0; i < CONTROLLER_DEVICES.length; i++) {
      if (CONTROLLER_DEVICES[i].id === id) return CONTROLLER_DEVICES[i];
    }
    return CONTROLLER_DEVICES[1]; // iPhone 14 fallback
  }
  function computeControllerDims(state) {
    var dev = findDevice(state.controllerDevice);
    var w = dev.w, h = dev.h;
    if (state.controllerOrientation === 'landscape') { var t = w; w = h; h = t; }
    var chromePx = state.controllerBrowserChrome
      ? BROWSER_CHROME[state.controllerOrientation === 'landscape' ? 'landscape' : 'portrait']
      : 0;
    // iframeH is the page's visible viewport (device minus chrome). chromePx
    // renders as a gray bar above the iframe; the card's total aspect ratio
    // stays at the device's physical dims so devices are comparable on-screen.
    return { iframeW: w, iframeH: h - chromePx, chromePx: chromePx, label: dev.label };
  }

  var STATE_KEY = 'tinytrack_gallery_state_v1';
  var defaults = {
    displayAR: '16x9',
    controllerDevice: 'iphone14',
    controllerOrientation: 'portrait',
    controllerBrowserChrome: false,
    players: 4,
    viewAs: 0
  };
  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if (!raw) return Object.assign({}, defaults);
      return Object.assign({}, defaults, JSON.parse(raw));
    } catch (e) { return Object.assign({}, defaults); }
  }
  function saveState(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // --- URL helpers ---
  function qs(obj) {
    var parts = [];
    for (var k in obj) {
      if (obj[k] === undefined || obj[k] === null || obj[k] === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  // Display page is served at `/`. Any scenario keeps the page off the relay.
  function displayURL(state, scenario, extra) {
    var p = {
      scenario: scenario,
      players: state.players
    };
    if (extra) for (var k in extra) p[k] = extra[k];
    return '/' + qs(p);
  }

  // Controller page is served at its canonical path. (It's also reachable in
  // play via a `/<room-code>` segment, but we don't use that here: the join
  // code `GALLERY` collides with the reserved `gallery` route, and any other
  // code is just an indirection — `/controller/index.html` serves the same
  // page and the TestHarness drives it from `?scenario=…`.)
  function controllerURL(scenario, colorIdx, extra) {
    var p = {
      scenario: scenario,
      color: colorIdx
    };
    if (extra) for (var k in extra) p[k] = extra[k];
    return '/controller/index.html' + qs(p);
  }

  // --- Lazy loading queue ---
  // Limits concurrent iframe loads so we don't blow past browser connection
  // limits (ERR_INSUFFICIENT_RESOURCES). Queue drains when iframes emit
  // 'load' events or after a timeout fallback.
  var MAX_CONCURRENT = 4;
  var active = 0;
  var queue = [];
  // Paused while a header <select> popup is (or may be) open. Chrome closes
  // open <select> popups whenever an iframe load completes in the same
  // document, so we hold off starting new loads while the popup is visible.
  var paused = false;
  var pauseSafetyTimer = null;
  var PAUSE_SAFETY_MS = 3000;
  function setLoadingPaused(p) {
    if (paused === p) return;
    paused = p;
    clearTimeout(pauseSafetyTimer);
    pauseSafetyTimer = null;
    if (paused) {
      pauseSafetyTimer = setTimeout(function() { setLoadingPaused(false); }, PAUSE_SAFETY_MS);
    } else {
      _drain();
    }
  }
  // Started tasks awaiting load/error/timeout. Tracked so resetQueue() can
  // abandon them: on re-render the old iframes are torn out of the DOM and
  // never fire `load`, so their slots would otherwise stay held for 12s.
  var inflight = [];
  function _drain() {
    while (!paused && active < MAX_CONCURRENT && queue.length) {
      // `let` so each iteration closes over its own task/done/iframe.
      let task = queue.shift();
      let iframe = task.iframe;
      let done = false;
      let fallback = null;
      task.started = true;
      active++;
      let cleanup = function() {
        clearTimeout(fallback);
        iframe.removeEventListener('load', finish);
        iframe.removeEventListener('error', finish);
        let idx = inflight.indexOf(task); if (idx >= 0) inflight.splice(idx, 1);
        active--;
      };
      let finish = function() {
        if (done) return; done = true;
        cleanup();
        task.onDone && task.onDone();
        _drain();
      };
      // Abandon a started load without firing onDone — used when the card is
      // torn down mid-load (resetQueue), so the slot is released immediately.
      task.cancel = function() { if (done) return; done = true; cleanup(); };
      inflight.push(task);
      iframe.addEventListener('load', finish);
      iframe.addEventListener('error', finish);
      // Fallback: the display page loads a WebGL scene + GLBs, so give it a
      // generous window before assuming the load event was missed. Cleared in
      // cleanup() so it doesn't sit pending for 12s after a normal load.
      fallback = setTimeout(finish, 12000);
      iframe.src = task.url; // mutable — _setUrl can retarget a not-yet-started task
    }
  }
  function enqueueLoad(iframe, url, onDone) {
    var task = { iframe: iframe, url: url, onDone: onDone, started: false, cancel: null };
    queue.push(task);
    _drain();
    return task;
  }
  // Abandon all queued + in-flight loads. Called at the top of render() before
  // the strip is rebuilt: the old iframes are about to leave the DOM (so their
  // load events would never fire), and their concurrency slots must be released
  // immediately or the new cards stall until the 12s fallback.
  function resetQueue() {
    queue = [];
    var pending = inflight.slice();
    inflight = [];
    for (var i = 0; i < pending.length; i++) if (pending[i].cancel) pending[i].cancel();
  }

  // Auto-pause loading while a header <select> popup is open. Only selects
  // need this — buttons and number inputs have no popup that an iframe load
  // can clobber.
  function autoPauseOnHeaderFocus() {
    var hdr = document.querySelector('header');
    if (!hdr) return;
    var selects = hdr.querySelectorAll('select');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      sel.addEventListener('pointerdown', function() { setLoadingPaused(true); });
      sel.addEventListener('focus', function() { setLoadingPaused(true); });
      sel.addEventListener('change', function() { setLoadingPaused(false); });
      sel.addEventListener('blur', function() { setLoadingPaused(false); });
    }
  }

  // --- Card factory ---
  function makeCard(opts) {
    // opts: { title, tag, frameClass, logical, url, replayable, chromePx }
    var card = document.createElement('div');
    card.className = 'card';

    var head = document.createElement('div');
    head.className = 'card-title';
    var title = document.createElement('span');
    var titleText = document.createTextNode(opts.title);
    title.appendChild(titleText);
    // Appended even when opts.tag is falsy — _setLabel writes to this node
    // unconditionally when viewAs changes, so it has to exist from the start.
    var tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = opts.tag ? ' ' + opts.tag : '';
    title.appendChild(tagEl);
    head.appendChild(title);

    var actions = document.createElement('div'); actions.className = 'actions';
    // Replay button calls window.__TEST__.replay() inside the iframe so
    // animated scenarios (countdown) can be re-run without reloading.
    if (opts.replayable) {
      var replayBtn = document.createElement('button');
      replayBtn.className = 'card-btn'; replayBtn.textContent = '▶';
      replayBtn.title = 'Replay animation';
      replayBtn.addEventListener('click', function() {
        try {
          var win = iframe.contentWindow;
          var fn = win && win.__TEST__ && win.__TEST__.replay;
          if (typeof fn === 'function') fn();
        } catch (_) { /* iframe not ready */ }
      });
      actions.appendChild(replayBtn);
    }
    var link = document.createElement('a');
    link.className = 'open-link'; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'open ↗'; link.href = opts.url;
    actions.appendChild(link);
    head.appendChild(actions);
    card.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'frame-wrap ' + opts.frameClass + ' pending';
    var chromeBar = document.createElement('div');
    chromeBar.className = 'chrome-bar';
    wrap.appendChild(chromeBar);
    var iframe = document.createElement('iframe');
    iframe.setAttribute('title', opts.title);
    wrap.appendChild(iframe);
    card.appendChild(wrap);

    // Mutable dim state — applyDims lets callers re-layout an existing card
    // (device swap, orientation flip, chrome toggle) without rebuilding the
    // iframe, preserving its loaded content.
    var curW = opts.logical.w, curH = opts.logical.h, curChrome = opts.chromePx || 0;

    function applyDims(logical, chromePx) {
      curW = logical.w; curH = logical.h; curChrome = chromePx || 0;
      var totalH = curH + curChrome;
      wrap.style.aspectRatio = curW + ' / ' + totalH;
      if (curChrome > 0) {
        var pct = (curChrome / totalH * 100) + '%';
        chromeBar.style.display = 'block';
        chromeBar.style.height = pct;
        iframe.style.top = pct;
      } else {
        chromeBar.style.display = 'none';
        iframe.style.top = '0';
      }
      iframe.style.width = curW + 'px';
      iframe.style.height = curH + 'px';
      rescale();
    }
    function rescale() {
      var rect = wrap.getBoundingClientRect();
      if (!rect.width) return;
      iframe.style.transform = 'scale(' + (rect.width / curW) + ')';
    }
    applyDims(opts.logical, opts.chromePx || 0);
    var _raf = requestAnimationFrame(rescale);
    var ro = new ResizeObserver(rescale);
    ro.observe(wrap);

    // Generation counter — each loadUrl bumps it, and onDone early-exits if
    // it no longer matches. Needed because rapid _setUrl calls on an already-
    // loaded card queue multiple concurrent loadUrl calls whose `load` event
    // listeners all fire against the same iframe once the final src settles.
    var _loadGen = 0;
    function loadUrl(url) {
      var gen = ++_loadGen;
      link.href = url;
      var task = enqueueLoad(iframe, url, function() {
        if (card._task === task) card._task = null;
        if (gen !== _loadGen) return;
        wrap.classList.remove('pending');
        card._loaded = true;
        var pending = card._pendingUrl;
        card._pendingUrl = null;
        if (pending && pending !== task.url) {
          wrap.classList.add('pending');
          loadUrl(pending);
        }
      });
      card._task = task;
    }

    card._loadUrl = loadUrl;
    card._initialUrl = opts.url;
    card._applyDims = applyDims;
    // Called by the page's render() before it tears down the strip, so stale
    // observers / pending callbacks don't pile up across re-renders.
    card._destroy = function() { ro.disconnect(); cancelAnimationFrame(_raf); };
    card._setLabel = function(newTitle, newTag) {
      titleText.nodeValue = newTitle;
      tagEl.textContent = newTag ? ' ' + newTag : '';
      iframe.setAttribute('title', newTitle);
    };
    // Retarget the card to a new URL. For already-mounted cards this swaps
    // the iframe src in place (no DOM rebuild); for cards still awaiting
    // lazy-mount it updates _initialUrl so lazyMount picks the new target.
    card._setUrl = function(url) {
      card._initialUrl = url;
      link.href = url;
      if (card._task) {
        // A load for this card is queued or in flight. If it hasn't started,
        // retarget it in place (no stale-URL load, no extra slot consumed);
        // if it's already loading, chain the new URL after it via _pendingUrl.
        if (!card._task.started) card._task.url = url;
        else card._pendingUrl = url;
      } else if (card._loaded) {
        wrap.classList.add('pending');
        loadUrl(url);
      }
      // else: not yet lazy-mounted — _initialUrl (set above) is what lazyMount
      // will load, so there's nothing more to queue.
    };
    return card;
  }

  // --- Intersection-based lazy mount ---
  // Observes cards and calls loadUrl only when they approach viewport, so the
  // browser isn't slammed with every WebGL display iframe at once.
  // Returns the IntersectionObserver so the caller can disconnect it on the
  // next render() (it holds references to every card it observes).
  function lazyMount(cards) {
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < cards.length; i++) cards[i]._loadUrl(cards[i]._initialUrl);
      return null;
    }
    var io = new IntersectionObserver(function(entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          var c = entries[i].target;
          io.unobserve(c);
          c._loadUrl(c._initialUrl);
        }
      }
    }, { rootMargin: '400px 0px' });
    for (var j = 0; j < cards.length; j++) io.observe(cards[j]);
    return io;
  }

  // --- Mobile options toggle ---
  function initMobileOptionsToggle() {
    var toggle = document.getElementById('options-toggle');
    var hdr = document.querySelector('header');
    if (!toggle || !hdr) return;
    toggle.addEventListener('click', function() {
      var open = hdr.classList.toggle('options-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? '✕' : '⚙';
      toggle.setAttribute('aria-label', open ? 'Close options' : 'Options');
    });
  }

  // --- Shared control binders ---
  function bindSelect(state, id, key, onChange, parse) {
    var el = document.getElementById(id);
    if (!el) return;
    if (state[key] !== undefined) el.value = String(state[key]);
    el.addEventListener('change', function(e) {
      state[key] = parse ? parse(e.target.value) : e.target.value;
      saveState(state); onChange();
    });
  }
  function bindCheckbox(state, id, key, onChange) {
    var el = document.getElementById(id);
    if (!el) return;
    el.checked = !!state[key];
    el.addEventListener('change', function(e) {
      state[key] = !!e.target.checked; saveState(state); onChange();
    });
  }

  return {
    PLAYER_COLOR_NAMES: PLAYER_COLOR_NAMES,
    DISPLAY_AR_DIMS: DISPLAY_AR_DIMS,
    CONTROLLER_DEVICES: CONTROLLER_DEVICES,
    BROWSER_CHROME: BROWSER_CHROME,
    computeControllerDims: computeControllerDims,
    loadState: loadState,
    saveState: saveState,
    displayURL: displayURL,
    controllerURL: controllerURL,
    makeCard: makeCard,
    lazyMount: lazyMount,
    resetQueue: resetQueue,
    setLoadingPaused: setLoadingPaused,
    autoPauseOnHeaderFocus: autoPauseOnHeaderFocus,
    initMobileOptionsToggle: initMobileOptionsToggle,
    bindSelect: bindSelect,
    bindCheckbox: bindCheckbox
  };
})();
