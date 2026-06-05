/* ═══════════════════════════════════════════════
   theme.js — reads CSS custom properties so
   Canvas 2D code matches the dual-theme stylesheet.
   ═══════════════════════════════════════════════ */

/**
 * Read theme colours from live CSS custom properties.
 * Call once at init and after every theme toggle.
 * Returns a frozen object — cheap to destructure on each render pass.
 */
export function readTheme() {
  const s = getComputedStyle(document.documentElement);
  return Object.freeze({
    bg0:    s.getPropertyValue("--bg0").trim()    || "#000000",
    bg1:    s.getPropertyValue("--bg1").trim()    || "#080808",
    bg2:    s.getPropertyValue("--bg2").trim()    || "#0e0e0e",
    bg3:    s.getPropertyValue("--bg3").trim()    || "#161616",
    t0:     s.getPropertyValue("--t0").trim()     || "#E8E5DF",
    t1:     s.getPropertyValue("--t1").trim()     || "rgba(232,229,223,0.73)",
    t2:     s.getPropertyValue("--t2").trim()     || "rgba(232,229,223,0.42)",
    t3:     s.getPropertyValue("--t3").trim()     || "rgba(232,229,223,0.22)",
    gold:   s.getPropertyValue("--gold").trim()   || "#C9A96E",
    goldBg: s.getPropertyValue("--gold-bg").trim()|| "rgba(201,169,110,0.08)",
    ok:     s.getPropertyValue("--ok").trim()     || "#5B9A6B",
    er:     s.getPropertyValue("--er").trim()     || "#C25450",
    wn:     s.getPropertyValue("--wn").trim()     || "#C9A96E",
  });
}
