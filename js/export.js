/* ==========================================================
   EXPORT.JS
   CSV telemetry export + PNG export of the active graph.
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    function downloadBlob(content, filename, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function exportCsv() {
        const rows = GCS.telemetryLog;
        if (!rows || rows.length === 0) {
            GCS.log('Command Executed', 'No telemetry data to export yet');
            return;
        }

        const headers = Object.keys(rows[0]);
        const lines = [headers.join(',')];
        rows.forEach(row => {
            lines.push(headers.map(h => row[h]).join(','));
        });

        downloadBlob(lines.join('\n'), `telemetry_log_${Date.now()}.csv`, 'text/csv');
        GCS.log('Command Executed', `Exported ${rows.length} telemetry rows to CSV`);
    }

    function exportGraph() {
        const canvasId = GCS.charts?.getActiveCanvasId?.();
        const canvas = canvasId && document.getElementById(canvasId);
        if (!canvas) {
            GCS.log('Command Executed', 'No active graph to export');
            return;
        }

        const url = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `${GCS.charts.getActiveKey()}_graph_${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();

        GCS.log('Command Executed', `Exported ${GCS.charts.getActiveKey()} graph as image`);
    }

    GCS.export = { exportCsv, exportGraph };

})(window.GCS);
