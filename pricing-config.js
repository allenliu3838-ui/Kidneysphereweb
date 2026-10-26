/**
 * pricing-config.js — Single source of truth for all pricing display.
 * Reads from window.CONFIG.BILLING (set in config.js).
 * All pages that display prices MUST use these helpers.
 */
(function(){
  "use strict";

  function B(){ return (window.CONFIG && window.CONFIG.BILLING) || {}; }

  var PricingConfig = {
    /** Get billing config object */
    billing: B,

    /** Format monthly base price, e.g. "¥499" */
    proMonthlyBase: function(){ return "¥" + (B().PRO_MONTHLY_BASE || 499); },

    /** Format yearly base price, e.g. "¥4,790" */
    proYearlyBase: function(){ return "¥" + (B().PRO_YEARLY_BASE || 4790).toLocaleString(); },

    /** Base project count, e.g. 3 */
    proBaseProjects: function(){ return B().PRO_BASE_PROJECTS || 3; },

    /** Monthly extra per project, e.g. "¥99" */
    proMonthlyExtra: function(){ return "¥" + (B().PRO_MONTHLY_EXTRA || 99); },

    /** Yearly extra per project, e.g. "¥950" */
    proYearlyExtra: function(){ return "¥" + (B().PRO_YEARLY_EXTRA || 950); },

    /** Short Pro summary: "¥499 / 月（含 3 个项目）" */
    proMonthlyLabel: function(){
      return PricingConfig.proMonthlyBase() + " / 月（含 " + PricingConfig.proBaseProjects() + " 个项目）";
    },

    /** Short yearly summary: "年付 ¥4,790 / 年（含 3 个项目，额外 +¥950 / 个 / 年）" */
    proYearlyLabel: function(){
      return "年付 " + PricingConfig.proYearlyBase() + " / 年（含 " + PricingConfig.proBaseProjects() + " 个项目，额外 +" + PricingConfig.proYearlyExtra() + " / 个 / 年）";
    },

    /** Extra project monthly label: "+¥99 / 个 / 月" */
    proMonthlyExtraLabel: function(){
      return "额外项目：+" + PricingConfig.proMonthlyExtra() + " / 个 / 月";
    },

    /** Render all [data-pricing] elements on the page */
    renderAll: function(){
      var els = document.querySelectorAll("[data-pricing]");
      for (var i = 0; i < els.length; i++){
        var key = els[i].getAttribute("data-pricing");
        if (PricingConfig[key] && typeof PricingConfig[key] === "function"){
          els[i].textContent = PricingConfig[key]();
        }
      }
    }
  };

  window.PricingConfig = PricingConfig;

  // Auto-render on DOMContentLoaded
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", PricingConfig.renderAll);
  } else {
    PricingConfig.renderAll();
  }
})();
