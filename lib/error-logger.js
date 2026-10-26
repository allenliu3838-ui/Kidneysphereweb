/**
 * error-logger.js — Minimal structured error logging for critical paths.
 * Captures errors and sends them to console + optional remote endpoint.
 * Does NOT log PII or credentials.
 */
(function(){
  "use strict";

  var LOG_ENDPOINT = null; // Set to a URL to enable remote logging

  var ErrorLogger = {
    /**
     * Log an error for a critical path.
     * @param {string} path - e.g. "checkout.submit", "staff.login", "demo.submit"
     * @param {Error|string} error - the error object or message
     * @param {Object} [meta] - additional context (no PII!)
     */
    log: function(path, error, meta){
      var entry = {
        ts: new Date().toISOString(),
        path: path,
        message: error instanceof Error ? error.message : String(error),
        url: location.pathname,
        ua: navigator.userAgent.slice(0, 120)
      };
      if (meta) entry.meta = meta;

      // Always log to console
      console.error("[ErrorLogger]", path, entry.message, meta || "");

      // Remote logging if configured
      if (LOG_ENDPOINT){
        try {
          navigator.sendBeacon(LOG_ENDPOINT, JSON.stringify(entry));
        } catch(e){
          // Silently fail — don't break the page for logging
        }
      }
    },

    /**
     * Wrap an async function with error logging.
     * @param {string} path
     * @param {Function} fn
     * @returns {Function}
     */
    wrap: function(path, fn){
      return async function(){
        try {
          return await fn.apply(this, arguments);
        } catch(e){
          ErrorLogger.log(path, e);
          throw e;
        }
      };
    }
  };

  window.ErrorLogger = ErrorLogger;

  // Global unhandled error handler
  window.addEventListener("error", function(event){
    ErrorLogger.log("global.error", event.error || event.message, {
      filename: event.filename,
      lineno: event.lineno
    });
  });

  window.addEventListener("unhandledrejection", function(event){
    ErrorLogger.log("global.unhandledrejection", event.reason || "unknown");
  });
})();
