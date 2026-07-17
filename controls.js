/* ==========================================================
   CONTROLS.JS
   Button wiring for the top control bar and the mission
   command panel (manual separation / parachute / redundant).
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    function setCommandFeedback(name, status) {
        GCS.util.setText('last-command', name);
        GCS.util.setText('command-status', status);
    }

    function flashCommandsDot(cls) {
        const dot = document.getElementById('commands-dot');
        if (!dot) return;
        dot.classList.remove('warn', 'crit');
        if (cls) dot.classList.add(cls);
        setTimeout(() => dot.classList.remove('warn', 'crit'), 4000);
    }

    function manualSeparation() {
        const p = GCS.state.payload;
        setCommandFeedback('Manual Separation', 'Executing…');

        if (p.released) {
            setCommandFeedback('Manual Separation', 'Already Separated');
            GCS.log('Command Executed', 'Manual separation ignored — payload already released');
            return;
        }

        p.released = true;
        GCS.util.setText('release-status', 'Released (manual)');
        GCS.faults.addFault('manualSeparation', 5000);
        flashCommandsDot('warn');
        setCommandFeedback('Manual Separation', 'Executed');
        GCS.log('Manual Separation', 'Payload separation commanded by operator');
    }

    function emergencyParachute() {
        GCS.state.commandOverride.parachuteActive = true;
        flashCommandsDot('crit');
        GCS.faults.addFault('parachute', 8000);
        setCommandFeedback('Emergency Parachute', 'Deployed');
        GCS.log('Emergency Parachute', 'Emergency parachute deployment commanded');

        // digit resets automatically as commandOverride flag clears
        setTimeout(() => { GCS.state.commandOverride.parachuteActive = false; }, 8000);
    }

    function redundantActivation() {
        flashCommandsDot('warn');
        setCommandFeedback('Redundant Activation', 'Executed');
        GCS.log('Command Executed', 'Redundant activation circuit fired');
    }

    function bindHeaderControls() {
        document.getElementById('start-btn')?.addEventListener('click', GCS.telemetry.start);
        document.getElementById('stop-btn')?.addEventListener('click', GCS.telemetry.stop);
        document.getElementById('export-csv-btn')?.addEventListener('click', GCS.export.exportCsv);
        document.getElementById('export-graph-btn')?.addEventListener('click', GCS.export.exportGraph);
        document.getElementById('sync-time-btn')?.addEventListener('click', GCS.telemetry.syncTime);
        document.getElementById('reset-packet-btn')?.addEventListener('click', GCS.telemetry.resetPacketCount);
    }

    function bindCommandPanel() {
        document.getElementById('manual-btn')?.addEventListener('click', manualSeparation);
        document.getElementById('parachute-btn')?.addEventListener('click', emergencyParachute);
        document.getElementById('redundant-btn')?.addEventListener('click', redundantActivation);
    }

    function init() {
        bindHeaderControls();
        bindCommandPanel();
    }

    GCS.controls = { init };

})(window.GCS);