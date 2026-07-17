/* ==========================================================
   ERROR.JS
   4-digit Mission Error Code System (assignment brief §5).

   Digit 1 — Descent Rate        0 = 8–10 m/s        1 = outside safe range
   Digit 2 — GPS Availability    0 = fix available    1 = GPS data unavailable
   Digit 3 — Payload Separation  0 = separated OK      1 = separation failure
   Digit 4 — Emergency Parachute 0 = inactive         1 = parachute activated

   Design notes / bug fixes vs. the earlier draft:
   - The old code kept ONE shared `code` variable that got
     reassigned by every check in turn, so only the last
     condition evaluated ever survived (and digits 3 & 4, for
     Payload Separation and Emergency Parachute, were never
     computed at all). Here each digit is its own independent
     0/1 value, computed every tick, exactly matching the
     table in the brief.
   - There were two different elements sharing id="err-digit-1"
     .."err-digit-4" in the old HTML (Mission State panel +
     a leftover duplicate block). getElementById always finds
     the first, silently orphaning the second. The duplicate
     block has been removed from index.html so this module has
     one unambiguous target per digit.
   - This module owns NOTHING but fault interpretation — it
     reads GCS.state (written by telemetry.js) and never
     mutates telemetry values, keeping the two modules decoupled
     via the 'gcs:update' custom event.
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    // Thresholds pulled straight from the brief's error-code table
    const DESCENT_RATE_MIN = 8;   // m/s
    const DESCENT_RATE_MAX = 10;  // m/s

    /* ---------------------------------------------------------
       Compute the four independent fault digits from live state
    --------------------------------------------------------- */

    function computeDigits(state) {
        const c = state.container;
        const p = state.payload;

        // Digit 1 — Descent Rate
        // Only evaluated once the vehicle is actually descending;
        // before that, descent rate is legitimately 0 and isn't a fault.
        const d1 = (state.phase === 'DESCENT' &&
                    (p.descentRate < DESCENT_RATE_MIN || p.descentRate > DESCENT_RATE_MAX)) ? 1 : 0;

        // Digit 2 — GPS Availability
        const d2 = c.gpsFix === 'No Fix' ? 1 : 0;

        // Digit 3 — Payload Separation
        // By Apogee/Descent/Landed the payload should already be released.
        // If it isn't, that's a separation failure.
        const d3 = (['APOGEE', 'DESCENT', 'LANDED'].includes(state.phase) && !p.released) ? 1 : 0;

        // Digit 4 — Emergency Parachute
        const d4 = state.commandOverride.parachuteActive ? 1 : 0;

        return [d1, d2, d3, d4];
    }

    /* ---------------------------------------------------------
       Paint the four error-code digit tiles
    --------------------------------------------------------- */

    function renderDigits(digits) {
        digits.forEach((val, i) => {
            const el = document.getElementById('err-digit-' + (i + 1));
            if (!el) return;
            el.textContent = String(val);
            el.classList.toggle('fault', val === 1);
        });
    }

    /* ---------------------------------------------------------
       Panel-level status dots — a quick-glance health summary
       per subsystem, separate from the individual value colors
       telemetry.js already applies to each reading.
    --------------------------------------------------------- */

    function setDot(id, level) {
        // level: 'ok' | 'warn' | 'crit'
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('warn', 'crit');
        if (level === 'warn') el.classList.add('warn');
        else if (level === 'crit') el.classList.add('crit');
    }

    function renderStatusDots(state, digits) {
        const [d1, d2, d3, d4] = digits;
        const c = state.container;
        const p = state.payload;

        // Container telemetry dot: battery + temperature health
        const containerCrit = c.battery < 6.4 || c.temperature > 65;
        const containerWarn = c.battery < 7.0 || c.temperature > 45;
        setDot('container-dot', containerCrit ? 'crit' : containerWarn ? 'warn' : 'ok');

        // Payload telemetry dot: battery + descent-rate fault (digit 1)
        const payloadCrit = p.battery < 3.2 || d1 === 1;
        const payloadWarn = p.battery < 3.5;
        setDot('payload-dot', payloadCrit ? 'crit' : payloadWarn ? 'warn' : 'ok');

        // GPS panel dot: digit 2
        setDot('gps-dot', d2 === 1 ? 'crit' : c.gpsFix === '2D' ? 'warn' : 'ok');

        // Orientation dot: just reflects link health once flying
        setDot('orientation-dot', state.connection === 'disconnected' && state.running ? 'crit' : 'ok');

        // Commands panel dot: digit 3 (separation) or digit 4 (parachute fired)
        setDot('commands-dot', d3 === 1 ? 'crit' : d4 === 1 ? 'warn' : 'ok');

        // Mission-state phase dot: any active fault at all
        const anyFault = digits.some(d => d === 1);
        setDot('phase-dot', anyFault ? 'warn' : 'ok');
    }

    /* ---------------------------------------------------------
       Main entry point — runs on every telemetry tick
    --------------------------------------------------------- */

    function evaluate(state) {
        const digits = computeDigits(state);
        renderDigits(digits);
        renderStatusDots(state, digits);
        return digits;
    }

    GCS.errorSystem = { evaluate, computeDigits };

    /* ---------------------------------------------------------
       Wire up to the shared telemetry event stream
    --------------------------------------------------------- */

    document.addEventListener('gcs:update', (e) => {
        evaluate(e.detail);
    });

    // paint an all-clear state immediately, before the first tick
    document.addEventListener('DOMContentLoaded', () => {
        if (GCS.state) evaluate(GCS.state);
    });

})(window.GCS);