// ==========================================================
// MISSION STATE / PHASE LADDER
// ==========================================================

function renderPhaseLadder() {
    const steps = document.querySelectorAll(".phase-step");
    const activeIndex = PHASES.indexOf(phase);
    steps.forEach((step, i) => {
        step.classList.remove("active", "done");
        if (i < activeIndex) step.classList.add("done");
        if (i === activeIndex) step.classList.add("active");
    });
}

function setPhase(next) {
    if (phase === next) return;
    phase = next;
    stateSeconds = 0;
    setText("state", next.charAt(0) + next.slice(1).toLowerCase());
    renderPhaseLadder();
    addConsoleMessage(`Phase change → ${next}`);

    const phaseDot = document.getElementById("phase-dot");
    phaseDot.className = "status-dot" + (next === "LANDED" ? " warn" : "");
}

function advancePhaseLogic() {
    if (!simulationRunning) return;

    stateSeconds++;
    setText("state-time", formatMissionTime(stateSeconds));

    if (phase === "ASCENT" && altitude >= APOGEE_TARGET) {
        setPhase("APOGEE");
    } else if (phase === "APOGEE" && stateSeconds >= 3) {
        setPhase("DESCENT");
        payloadReleased = true;
        setText("release-status", "Released");
        addConsoleMessage("Payload separation confirmed");
    } else if (phase === "DESCENT" && altitude <= 0.5) {
        altitude = 0;
        setPhase("LANDED");
        simulationRunning = false;
        addConsoleMessage("Touchdown confirmed — telemetry hold");
    }
}

renderPhaseLadder();