/**
 * Client-side rate limiter.
 *
 * Provides a simple per-action throttle to prevent accidental or
 * malicious rapid-fire requests from the browser. This is a UX
 * guard — real rate limiting is enforced server-side by Supabase
 * GoTrue (auth) and RLS (data).
 *
 * Usage:
 *   import { throttle } from "/lib/rate-limit.js";
 *   const rl = throttle("login", { maxAttempts: 5, windowMs: 15 * 60_000 });
 *   if (!rl.allow()) { toast(rl.message); return; }
 */

const _stores = {};

export function throttle(action, { maxAttempts = 5, windowMs = 15 * 60_000, message = "操作过于频繁，请稍后再试" } = {}) {
  if (!_stores[action]) {
    _stores[action] = { attempts: [], windowMs, maxAttempts, message };
  }
  const s = _stores[action];

  return {
    allow() {
      const now = Date.now();
      // Remove expired entries
      s.attempts = s.attempts.filter(t => now - t < s.windowMs);
      if (s.attempts.length >= s.maxAttempts) {
        const waitSec = Math.ceil((s.attempts[0] + s.windowMs - now) / 1000);
        s._lastWait = waitSec;
        return false;
      }
      s.attempts.push(now);
      return true;
    },
    get message() {
      const wait = s._lastWait || Math.ceil(s.windowMs / 1000);
      const min = Math.ceil(wait / 60);
      return `${s.message}（请等待约 ${min} 分钟）`;
    },
    reset() {
      s.attempts = [];
    },
  };
}
