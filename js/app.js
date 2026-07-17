/* ==========================================================
   APP.JS
   Bootstraps every module once the DOM is ready.
========================================================== */

window.GCS = window.GCS || {};

document.addEventListener('DOMContentLoaded', () => {
    GCS.charts?.init();
    GCS.map?.init();
    GCS.orientation?.init();
    GCS.video?.init();
    GCS.controls?.init();

    GCS.log('Command Executed', 'Ground Control Software initialized');
});
