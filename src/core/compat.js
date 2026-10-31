// webOS 4.x 兼容层。
//
// webOS 3.5 / 4.0 / 4.5 的内核是 Chromium 53，比 webOS 5（68）、6（79）老一档。
// Vite 的 target 只能把语法降级（async/await、对象展开、可选链等），运行时缺失的
// API 还得自己补：这里只在缺失时打补丁，新版电视和浏览器完全不受影响。
//
// 补的清单来自逐项核对：项目源码 + hls.js 1.6 的实际使用。
//   Promise.prototype.finally  Chromium 63
//   String.prototype.padStart  Chromium 57
//   Object.entries / values    Chromium 54
//   AbortController            Chromium 66
//   scrollIntoView(options)    Chromium 61
//
// 注意：Object.getOwnPropertyDescriptors（Chromium 54）不在这里补。打包产物会在
// 主 IIFE 之外、脚本加载瞬间就捕获它来构造对象展开辅助函数，早于本模块执行，
// 因此它由 index.html 的内联脚本在加载主脚本之前补好，见该文件顶部注释。
//
// 必须作为 main.js 的第一个 import，保证在其它模块执行前完成打补丁。

if (typeof Promise !== 'undefined' && !Promise.prototype.finally) {
  Promise.prototype.finally = function (onFinally) {
    const P = this.constructor || Promise;
    return this.then(
      (value) => P.resolve(onFinally && onFinally()).then(() => value),
      (reason) =>
        P.resolve(onFinally && onFinally()).then(() => {
          throw reason;
        })
    );
  };
}

if (!String.prototype.padStart) {
  String.prototype.padStart = function (targetLength, padString) {
    const s = String(this);
    const len = targetLength >> 0;
    const pad = padString === undefined ? ' ' : String(padString);
    if (s.length >= len || !pad) return s;
    let out = '';
    const need = len - s.length;
    while (out.length < need) out += pad;
    return out.slice(0, need) + s;
  };
}

if (!String.prototype.padEnd) {
  String.prototype.padEnd = function (targetLength, padString) {
    const s = String(this);
    const len = targetLength >> 0;
    const pad = padString === undefined ? ' ' : String(padString);
    if (s.length >= len || !pad) return s;
    let out = '';
    const need = len - s.length;
    while (out.length < need) out += pad;
    return s + out.slice(0, need);
  };
}

if (!Object.entries) {
  Object.entries = function (obj) {
    const out = [];
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) out.push([key, obj[key]]);
    }
    return out;
  };
}

if (!Object.values) {
  Object.values = function (obj) {
    const out = [];
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
    }
    return out;
  };
}

if (!Object.fromEntries) {
  Object.fromEntries = function (entries) {
    const out = {};
    for (const pair of entries) out[pair[0]] = pair[1];
    return out;
  };
}

function abortError() {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch (e) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  }
}

// Chromium 53 没有 AbortController，原生 fetch 也不认识 signal。
// 这里补一个最小实现，并把 fetch 包一层：abort 时让 fetch 的 Promise 立刻
// reject（请求本身没法真正取消，但调用方的超时/让路逻辑能照常推进）。
// 项目里主动 abort 的场景几乎都是超时和换台让路，这个语义已经够用。
if (typeof AbortController === 'undefined') {
  class AbortSignalPolyfill {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this._listeners = [];
    }

    addEventListener(type, fn, opts) {
      if (type !== 'abort' || typeof fn !== 'function') return;
      const entry = { fn, once: !!(opts && opts.once) };
      this._listeners.push(entry);
    }

    removeEventListener(type, fn) {
      if (type !== 'abort') return;
      this._listeners = this._listeners.filter((e) => e.fn !== fn);
    }

    _fire() {
      const event = { type: 'abort', target: this };
      const list = this._listeners.slice();
      this._listeners.length = 0;
      if (typeof this.onabort === 'function') {
        try {
          this.onabort(event);
        } catch (e) {}
      }
      for (const entry of list) {
        try {
          entry.fn(event);
        } catch (e) {}
      }
    }
  }

  class AbortControllerPolyfill {
    constructor() {
      this.signal = new AbortSignalPolyfill();
    }

    abort(reason) {
      const signal = this.signal;
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason;
      signal._fire();
    }
  }

  window.AbortController = AbortControllerPolyfill;
  window.AbortSignal = AbortSignalPolyfill;

  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const signal = init && init.signal;
      if (!signal) return nativeFetch.call(window, input, init);
      if (signal.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        nativeFetch.call(window, input, init).then(
          (res) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(res);
          },
          (err) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(err);
          }
        );
      });
    };
  }
}

// Chromium 53 的 scrollIntoView 只认布尔参数，传对象会把焦点行顶到列表上沿。
// 遥控器操作需要焦点尽量居中，这里在旧内核上手动算最近可滚动祖先的 scrollTop。
if (
  typeof Element !== 'undefined' &&
  Element.prototype.scrollIntoView &&
  !('scrollBehavior' in document.documentElement.style)
) {
  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    if (!arg || typeof arg !== 'object') {
      nativeScrollIntoView.call(this, arg);
      return;
    }
    try {
      let parent = this.parentNode;
      while (parent && parent.nodeType === 1) {
        const style = window.getComputedStyle(parent);
        const scrollable = /(auto|scroll)/.test(style.overflowY);
        if (scrollable && parent.scrollHeight > parent.clientHeight) break;
        parent = parent.parentNode;
      }
      if (!parent || parent.nodeType !== 1) {
        nativeScrollIntoView.call(this, false);
        return;
      }
      const elRect = this.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      parent.scrollTop += elRect.top - parentRect.top - (parent.clientHeight - elRect.height) / 2;
    } catch (e) {
      nativeScrollIntoView.call(this, false);
    }
  };
}
