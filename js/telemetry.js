/* ==========================================================
   TELEMETRY.JS
   Core simulation engine + shared GCS utilities.
   Everything else (charts, map, orientation, video, export,
   controls, error) listens for the 'gcs:update' event this
   file dispatches, so modules stay decoupled from each other.

   NOTE: The 4-digit mission Error Code (Descent Rate / GPS /
   Payload Separation / Emergency Parachute) is intentionally
   NOT computed here anymore — that logic now lives entirely
   in js/error.js, which is the single source of truth for the
   error-code-digits UI. Keeping it in one place fixes the bug
   where two different scripts both tried to write err-digit-1..4
   and stomped on each other.
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    /* ---------------------------------------------------------
       Small shared helpers
    --------------------------------------------------------- */

    function pad(num, len) {
        return String(Math.max(0, Math.round(num))).padStart(len, '0');
    }

    function clamp(v, min, max) {
        return Math.min(max, Math.max(min, v));
    }

    function rand(min, max) {
        return min + Math.random() * (max - min);
    }

    function fmtClock(totalSeconds) {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = Math.floor(totalSeconds % 60);
        return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
    }

    function setValueColor(el, colorClass) {
        if (!el) return;
        el.classList.remove('val-green', 'val-amber', 'val-red', 'val-blue');
        el.classList.add(colorClass);
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    GCS.util = { pad, clamp, rand, fmtClock, setValueColor, setText };

    /* ---------------------------------------------------------
       Mission Console logging
       Event category -> color class + icon, per assignment spec
    --------------------------------------------------------- */

    const LOG_RULES = [
        { type: 'success', icon: '✔', match: ['Mission Started', 'Mission Completed', 'Command Executed', 'Payload Released Successfully'] },
        { type: 'info', icon: 'ℹ', match: ['Telemetry Packet', 'GPS Updated', 'Synchronization Completed'] },
        { type: 'warning', icon: '⚠', match: ['Low Battery', 'Weak GPS', 'High Temperature', 'Manual Separation'] },
        { type: 'critical', icon: '✖', match: ['Communication Lost', 'Emergency Parachute', 'Critical Failure', 'Sensor Failure'] }
    ];

    function classifyEvent(eventName) {
        for (const rule of LOG_RULES) {
            if (rule.match.some(m => eventName.toLowerCase().includes(m.toLowerCase()))) {
                return rule;
            }
        }
        return { type: 'info', icon: 'ℹ' };
    }

    const MAX_LOG_LINES = 150;

    function log(eventName, message) {
        const logEl = document.getElementById('console-log');
        if (!logEl) return;

        const rule = classifyEvent(eventName);
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });

        const line = document.createElement('p');
        line.innerHTML =
            `<span class="log-time">${time}</span>` +
            `<span class="log-${rule.type}">${rule.icon} ${eventName}${message ? ' — ' + message : ''}</span>`;

        logEl.appendChild(line);

        while (logEl.children.length > MAX_LOG_LINES) {
            logEl.removeChild(logEl.firstChild);
        }

        // newest entry always visible
        logEl.scrollTop = logEl.scrollHeight;
    }

    GCS.log = log;

    /* ---------------------------------------------------------
       Alert / warning banner
    --------------------------------------------------------- */

    // priority order: highest first. key -> { level: 'critical'|'warning', text }
    const ALERT_PRIORITY = [
        'parachute', 'commLost', 'batteryCritical', 'gpsLost',
        'sensorFailure', 'unexpectedRelease',
        'batteryLow', 'weakGps', 'highTemp', 'manualSeparation'
    ];

    const ALERT_TEXT = {
        parachute: { level: 'critical', text: 'EMERGENCY PARACHUTE DEPLOYED' },
        commLost: { level: 'critical', text: 'COMMUNICATION LOST WITH VEHICLE' },
        batteryCritical: { level: 'critical', text: 'BATTERY CRITICAL' },
        gpsLost: { level: 'critical', text: 'GPS SIGNAL LOST' },
        sensorFailure: { level: 'critical', text: 'SENSOR FAILURE DETECTED' },
        unexpectedRelease: { level: 'critical', text: 'PAYLOAD RELEASED UNEXPECTEDLY' },
        batteryLow: { level: 'warning', text: 'LOW BATTERY' },
        weakGps: { level: 'warning', text: 'WEAK GPS SIGNAL' },
        highTemp: { level: 'warning', text: 'HIGH TEMPERATURE' },
        manualSeparation: { level: 'warning', text: 'MANUAL SEPARATION IN PROGRESS' }
    };

    const activeFaults = new Map(); // key -> expiry timestamp (ms) or Infinity

    function addFault(key, durationMs) {
        const isNew = !activeFaults.has(key);
        activeFaults.set(key, durationMs ? Date.now() + durationMs : Infinity);
        if (isNew) {
            const info = ALERT_TEXT[key];
            log(info.text, null);
        }
    }

    function clearFault(key) {
        activeFaults.delete(key);
    }

    function expireFaults() {
        const now = Date.now();
        for (const [key, expiry] of activeFaults.entries()) {
            if (expiry <= now) activeFaults.delete(key);
        }
    }

    function refreshAlertBanner() {
        expireFaults();

        const banner = document.getElementById('alert-banner');
        const icon = document.getElementById('alert-icon');
        const text = document.getElementById('alert-text');
        if (!banner) return;

        let activeKey = null;
        for (const key of ALERT_PRIORITY) {
            if (activeFaults.has(key)) { activeKey = key; break; }
        }

        if (!activeKey) {
            banner.hidden = true;
            banner.classList.remove('warning', 'critical');
            return;
        }

        const info = ALERT_TEXT[activeKey];
        banner.hidden = false;
        banner.classList.toggle('critical', info.level === 'critical');
        banner.classList.toggle('warning', info.level === 'warning');
        icon.textContent = info.level === 'critical' ? '✖' : '⚠';
        text.textContent = info.text;
    }

    function clearAllFaults() {
        activeFaults.clear();
        refreshAlertBanner();
    }

    GCS.faults = { addFault, clearFault, clearAll: clearAllFaults, has: k => activeFaults.has(k) };

    /* ---------------------------------------------------------
       Mission / simulation state
    --------------------------------------------------------- */

    const state = {
        running: false,
        connection: 'disconnected',      // disconnected | searching | connected
        phase: 'PRELAUNCH',
        phaseElapsed: 0,                 // seconds in current phase
        metSeconds: 0,

        packetCount: 0,
        payloadPacketCount: 0,
        packetTimestamps: [],
        packetRateHz: 0,

        container: {
            altitude: 0, pressure: 1013.25, temperature: 25.0, battery: 7.40,
            sats: 0, hdop: 20, gpsFix: 'No Fix', lat: 20.148600, lng: 85.671000,
            signal: 95
        },
        payload: {
            altitude: 0, pressure: 1013.25, temperature: 25.0, battery: 3.70,
            descentRate: 0, released: false
        },
        orientation: { roll: 0, pitch: 0, yaw: 0 },

        apogeeAltitude: rand(650, 900),
        ascentRate: rand(8.5, 11.5),
        descentRateTarget: rand(8.3, 9.8),

        commandOverride: { parachuteActive: false, separationForced: false }
    };

    GCS.state = state;
    GCS.telemetryLog = []; // rows for CSV export

    let tickTimer = null;
    let clockTimer = null;

    /* ---------------------------------------------------------
       Footer + connection UI
    --------------------------------------------------------- */

    function setConnectionUI(mode) {
        state.connection = mode;

        const led = document.getElementById('connection-led');
        const statusText = document.getElementById('connection-status');
        const footerStatus = document.getElementById('footer-connection-status');
        const comPort = document.getElementById('com-port');

        if (led) led.classList.remove('disconnected', 'searching', 'connected', 'on');

        if (mode === 'connected') {
            if (led) led.classList.add('connected');
            if (statusText) statusText.textContent = 'Connected';
            if (footerStatus) footerStatus.textContent = 'Connected';
            if (comPort) { comPort.textContent = 'COM4'; comPort.classList.add('connected'); }
        } else if (mode === 'searching') {
            if (led) led.classList.add('searching');
            if (statusText) statusText.textContent = 'Searching…';
            if (footerStatus) footerStatus.textContent = 'Searching…';
        } else {
            if (led) led.classList.add('disconnected');
            if (statusText) statusText.textContent = 'Disconnected';
            if (footerStatus) footerStatus.textContent = 'Disconnected';
            if (comPort) { comPort.textContent = 'Not Connected'; comPort.classList.remove('connected'); }
        }
    }

    GCS.setConnectionUI = setConnectionUI;

    /* ---------------------------------------------------------
       Physics / mission phase progression
    --------------------------------------------------------- */

    const PHASES = ['PRELAUNCH', 'ASCENT', 'APOGEE', 'DESCENT', 'LANDED'];
    GCS.PHASES = PHASES;

    function setPhase(next) {
        if (state.phase === next) return;
        state.phase = next;
        state.phaseElapsed = 0;

        document.querySelectorAll('.phase-step').forEach(step => {
            const p = step.dataset.phase;
            step.classList.remove('active', 'done');
            if (p === next) step.classList.add('active');
            else if (PHASES.indexOf(p) < PHASES.indexOf(next)) step.classList.add('done');
        });

        GCS.util.setText('state', next.charAt(0) + next.slice(1).toLowerCase());
        log('Command Executed', `Mission phase → ${next}`);
    }

    function stepPhysics(dt) {
        const c = state.container;
        const p = state.payload;

        switch (state.phase) {

            case 'PRELAUNCH':
                c.altitude = clamp(c.altitude + rand(-0.05, 0.05), 0, 2);
                if (state.phaseElapsed > 3) setPhase('ASCENT');
                break;

            case 'ASCENT':
                c.altitude += state.ascentRate * dt + rand(-0.3, 0.3);
                if (c.altitude >= state.apogeeAltitude) setPhase('APOGEE');
                break;

            case 'APOGEE':
                c.altitude += rand(-0.2, 0.2);
                if (state.phaseElapsed > 2) {
                    if (!p.released) autoRelease();
                    setPhase('DESCENT');
                }
                break;

            case 'DESCENT': {
                // occasional out-of-range descent rate for realism / fault demo
                const rateNoise = Math.random() < 0.06 ? rand(2, 5) : rand(-0.6, 0.6);
                const rate = state.commandOverride.parachuteActive
                    ? clamp(state.descentRateTarget + rand(-0.3, 0.3), 8, 9.5)
                    : state.descentRateTarget + rateNoise;

                c.altitude = clamp(c.altitude - rate * dt, 0, 999999);
                p.descentRate = rate;

                if (c.altitude <= 0.05) {
                    c.altitude = 0;
                    p.descentRate = 0;
                    setPhase('LANDED');
                }
                break;
            }

            case 'LANDED':
                c.altitude = 0;
                p.descentRate = 0;
                break;
        }

        // payload altitude tracks container once separated, both essentially the same stack
        p.altitude = Math.max(0, c.altitude - (p.released ? rand(0, 1.5) : 0));

        // atmosphere model (barometric formula)
        c.pressure = 1013.25 * Math.pow(1 - 2.25577e-5 * c.altitude, 5.25588);
        p.pressure = 1013.25 * Math.pow(1 - 2.25577e-5 * p.altitude, 5.25588);

        // temperature: lapse rate + slow drift + rare spikes
        const lapse = -0.0065 * c.altitude;
        c.temperature = clamp(25 + lapse + rand(-0.4, 0.4) + (Math.random() < 0.015 ? rand(10, 25) : 0), -20, 90);
        p.temperature = clamp(25 + lapse + rand(-0.4, 0.4) + (Math.random() < 0.015 ? rand(10, 25) : 0), -20, 90);

        // battery drains slowly over the mission, rare fast-drain fault
        const drain = (state.phase === 'PRELAUNCH' ? 0.0004 : 0.0015) + (Math.random() < 0.01 ? 0.05 : 0);
        c.battery = clamp(c.battery - drain, 5.8, 7.6);
        p.battery = clamp(p.battery - drain * 0.6, 2.8, 4.05);

        // GPS
        if (Math.random() < 0.02) {
            c.sats = Math.max(0, c.sats + Math.round(rand(-3, 3)));
        } else {
            c.sats = clamp(Math.round(c.sats + rand(-0.4, 0.6)), 0, 14);
        }
        if (state.phase === 'PRELAUNCH' && c.sats < 6) c.sats = Math.round(rand(6, 11));
        c.gpsFix = c.sats >= 6 ? '3D' : c.sats >= 3 ? '2D' : 'No Fix';
        c.hdop = c.sats > 0 ? clamp(18 / c.sats, 0.7, 20) : 20;

        // drift the ground-track position a little so the map path is visible
        c.lat += rand(-0.00004, 0.00004) + (state.phase === 'DESCENT' ? rand(0.00001, 0.00006) : 0);
        c.lng += rand(-0.00004, 0.00004) + (state.phase === 'DESCENT' ? rand(0.00001, 0.00006) : 0);

        // signal strength weakens with altitude/range, recovers near ground
        c.signal = clamp(96 - c.altitude * 0.03 + rand(-4, 4), 8, 99);

        // orientation: gentle tumble that stabilizes once a parachute is out
        const damp = (state.phase === 'DESCENT' || state.phase === 'LANDED') ? 0.4 : 1;
        state.orientation.roll = clamp(state.orientation.roll + rand(-4, 4) * damp, -45, 45);
        state.orientation.pitch = clamp(state.orientation.pitch + rand(-3, 3) * damp, -35, 35);
        state.orientation.yaw = (state.orientation.yaw + rand(-6, 6) * damp + 360) % 360;

        state.phaseElapsed += dt;
    }

    function autoRelease() {
        state.payload.released = true;
        GCS.util.setText('release-status', 'Released');
        log('Payload Released Successfully', 'Automatic separation at apogee');
    }

    /* ---------------------------------------------------------
       Fault evaluation from real sensor values + random injects
       (drives the alert banner only — the 4-digit error code
       lives in error.js and reads GCS.state directly)
    --------------------------------------------------------- */

    function evaluateFaults() {
        const c = state.container;
        const p = state.payload;

        // battery
        if (c.battery < 6.4 || p.battery < 3.2) {
            addFault('batteryCritical', 6000);
        } else if (c.battery < 7.0 || p.battery < 3.5) {
            addFault('batteryLow', 6000);
        } else {
            clearFault('batteryCritical');
            clearFault('batteryLow');
        }

        // gps
        if (c.gpsFix === 'No Fix') {
            addFault('gpsLost', 6000);
        } else if (c.gpsFix === '2D') {
            addFault('weakGps', 6000);
        } else {
            clearFault('gpsLost');
            clearFault('weakGps');
        }

        // temperature
        if (c.temperature > 65 || p.temperature > 65) {
            addFault('sensorFailure', 5000);
        } else if (c.temperature > 45 || p.temperature > 45) {
            addFault('highTemp', 5000);
        } else {
            clearFault('sensorFailure');
            clearFault('highTemp');
        }

        // random comm dropout + unexpected release (rare, for demo realism)
        if (state.running && Math.random() < 0.004) addFault('commLost', 4000);
        if (state.running && !p.released && state.phase === 'ASCENT' && Math.random() < 0.0015) {
            p.released = true;
            GCS.util.setText('release-status', 'Released (unexpected)');
            addFault('unexpectedRelease', 7000);
        }

        refreshAlertBanner();
    }

    /* ---------------------------------------------------------
       DOM render of one telemetry tick
       (NOTE: error-code digits are rendered by error.js, which
       listens for 'gcs:update' — see bottom of tick())
    --------------------------------------------------------- */

    function render() {
        const c = state.container, p = state.payload;

        GCS.util.setText('telemetry-mission-time', fmtClock(state.metSeconds));
        GCS.util.setText('header-mission-time', fmtClock(state.metSeconds));
        GCS.util.setText('state-time', fmtClock(state.phaseElapsed));
        GCS.util.setText('packet-count', pad(state.packetCount, 6));
        GCS.util.setText('payload-packet-count', pad(state.payloadPacketCount, 6));
        GCS.util.setText('packet-rate', state.packetRateHz.toFixed(0) + ' Hz');
        GCS.util.setText('footer-packets', pad(state.packetCount, 6));

        GCS.util.setText('altitude', c.altitude.toFixed(1) + ' m');
        GCS.util.setText('pressure', c.pressure.toFixed(1) + ' hPa');
        GCS.util.setText('payload-altitude', p.altitude.toFixed(1) + ' m');
        GCS.util.setText('payload-pressure', p.pressure.toFixed(1) + ' hPa');
        GCS.util.setText('descent-rate', p.descentRate.toFixed(1) + ' m/s');

        // temperature (color: blue normal / amber high / red critical)
        const tEl = document.getElementById('temperature');
        GCS.util.setText('temperature', c.temperature.toFixed(1) + ' °C');
        setValueColor(tEl, c.temperature > 65 ? 'val-red' : c.temperature > 45 ? 'val-amber' : 'val-blue');

        const ptEl = document.getElementById('payload-temperature');
        GCS.util.setText('payload-temperature', p.temperature.toFixed(1) + ' °C');
        setValueColor(ptEl, p.temperature > 65 ? 'val-red' : p.temperature > 45 ? 'val-amber' : 'val-blue');

        // battery (color: green / amber / red)
        const bEl = document.getElementById('battery');
        GCS.util.setText('battery', c.battery.toFixed(2) + ' V');
        setValueColor(bEl, c.battery < 6.4 ? 'val-red' : c.battery < 7.0 ? 'val-amber' : 'val-green');

        const pbEl = document.getElementById('payload-battery');
        GCS.util.setText('payload-battery', p.battery.toFixed(2) + ' V');
        setValueColor(pbEl, p.battery < 3.2 ? 'val-red' : p.battery < 3.5 ? 'val-amber' : 'val-green');

        // GPS (color: green fix / red no fix)
        const gpsEl = document.getElementById('gps');
        const fixText = c.gpsFix === 'No Fix' ? 'No Fix' : `${c.gpsFix} Fix`;
        GCS.util.setText('gps', fixText);
        setValueColor(gpsEl, c.gpsFix === 'No Fix' ? 'val-red' : 'val-green');

        const gpsFixEl = document.getElementById('gps-fix');
        GCS.util.setText('gps-fix', c.gpsFix);
        setValueColor(gpsFixEl, c.gpsFix === 'No Fix' ? 'val-red' : c.gpsFix === '2D' ? 'val-amber' : 'val-green');

        GCS.util.setText('sats', String(c.sats));
        GCS.util.setText('hdop', c.hdop.toFixed(1));
        GCS.util.setText('latitude', c.lat.toFixed(6));
        GCS.util.setText('longitude', c.lng.toFixed(6));

        // signal strength (footer, color coded %)
        const sigEl = document.getElementById('signal-strength');
        GCS.util.setText('signal-strength', Math.round(c.signal) + ' %');
        setValueColor(sigEl, c.signal < 40 ? 'val-red' : c.signal < 70 ? 'val-amber' : 'val-green');
    }

    /* ---------------------------------------------------------
       Main tick — variable interval so Packet Rate feels real
    --------------------------------------------------------- */

    function scheduleTick() {
        if (!state.running) return;
        // mostly ~1 Hz, occasional faster bursts (2-5 Hz) for realism
        const interval = Math.random() < 0.15 ? rand(180, 500) : rand(900, 1050);
        tickTimer = setTimeout(tick, interval);
    }

    let lastTickAt = null;

    function tick() {
        const now = Date.now();
        const dt = lastTickAt ? (now - lastTickAt) / 1000 : 1;
        lastTickAt = now;

        stepPhysics(clamp(dt, 0.05, 2));

        state.packetCount++;
        state.payloadPacketCount++;
        state.packetTimestamps.push(now);
        state.packetTimestamps = state.packetTimestamps.filter(t => now - t <= 3000);
        state.packetRateHz = state.packetTimestamps.length / 3;

        evaluateFaults();
        render();

        GCS.telemetryLog.push({
            met: fmtClock(state.metSeconds),
            phase: state.phase,
            containerAltitude: state.container.altitude.toFixed(1),
            containerPressure: state.container.pressure.toFixed(1),
            containerTemperature: state.container.temperature.toFixed(1),
            containerBattery: state.container.battery.toFixed(2),
            payloadAltitude: state.payload.altitude.toFixed(1),
            payloadTemperature: state.payload.temperature.toFixed(1),
            payloadBattery: state.payload.battery.toFixed(2),
            descentRate: state.payload.descentRate.toFixed(1),
            lat: state.container.lat.toFixed(6),
            lng: state.container.lng.toFixed(6),
            sats: state.container.sats,
            gpsFix: state.container.gpsFix,
            roll: state.orientation.roll.toFixed(1),
            pitch: state.orientation.pitch.toFixed(1),
            yaw: state.orientation.yaw.toFixed(0)
        });

        // every other module (charts, map, orientation, error digits...)
        // reacts to this single event instead of being called directly
        document.dispatchEvent(new CustomEvent('gcs:update', { detail: state }));

        scheduleTick();
    }

    /* ---------------------------------------------------------
       Public start / stop / reset
    --------------------------------------------------------- */

    function start() {
        if (state.running) return;
        state.running = true;
        lastTickAt = null;

        setConnectionUI('searching');
        log('Mission Started', 'Telemetry link initializing');

        setTimeout(() => {
            if (!state.running) return;
            setConnectionUI('connected');
            log('Telemetry Packet', 'Link established, receiving data');
        }, 900);

        clockTimer = setInterval(() => {
            if (state.running) state.metSeconds++;
            const el = document.getElementById('ground-time');
            if (el) el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
        }, 1000);

        scheduleTick();
    }

    function stop() {
        if (!state.running) return;
        state.running = false;
        clearTimeout(tickTimer);
        clearInterval(clockTimer);
        setConnectionUI('disconnected');
        clearAllFaults();
        log('Mission Completed', 'Telemetry streaming stopped');
        // final event so error.js / dots settle into a clean state
        document.dispatchEvent(new CustomEvent('gcs:update', { detail: state }));
    }

    function resetPacketCount() {
        state.packetCount = 0;
        state.payloadPacketCount = 0;
        state.packetTimestamps = [];
        state.packetRateHz = 0;
        GCS.util.setText('packet-count', pad(0, 6));
        GCS.util.setText('payload-packet-count', pad(0, 6));
        GCS.util.setText('packet-rate', '0 Hz');
        GCS.util.setText('footer-packets', pad(0, 6));
        log('Command Executed', 'Packet counter reset');
    }

    function syncTime() {
        const now = new Date();
        const el = document.getElementById('ground-time');
        if (el) el.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
        log('Synchronization Completed', 'Ground station clock synced to PC time');
    }

    GCS.telemetry = { start, stop, resetPacketCount, syncTime, setPhase };

    // initial paint so the UI isn't blank before first Start
    document.addEventListener('DOMContentLoaded', () => {
        setConnectionUI('disconnected');
        render();
        refreshAlertBanner();
        // let error.js paint its initial (all-clear) state too
        document.dispatchEvent(new CustomEvent('gcs:update', { detail: state }));
    });

})(window.GCS);
