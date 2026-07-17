// ==========================================================
// MISSION TIMER
// ==========================================================

function updateMissionTime() {
    if (!simulationRunning) return;
    seconds++;
    const time = formatMissionTime(seconds);
    setText("header-mission-time", time);
    setText("telemetry-mission-time", time);
}