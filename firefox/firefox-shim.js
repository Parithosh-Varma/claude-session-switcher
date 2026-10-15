// Firefox compatibility shim. Loaded BEFORE shared.js.
// Firefox exposes the `browser` namespace; this aliases it to `chrome`
// so the shared core works unmodified. Chrome ignores this file.
if (typeof chrome === "undefined" && typeof browser !== "undefined") {
  // eslint-disable-next-line no-undef, no-var, no-redeclare
  var chrome = browser;
}
