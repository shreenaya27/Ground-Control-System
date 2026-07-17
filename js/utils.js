// ==========================================================
// UTIL
// ==========================================================

function pad(n) { return String(n).padStart(2, "0"); }

function formatMissionTime(totalSeconds) {
    const hrs = pad(Math.floor(totalSeconds / 3600));
    const mins = pad(Math.floor((totalSeconds % 3600) / 60));
    const secs = pad(totalSeconds % 60);
    return `${hrs}:${mins}:${secs}`;
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}
