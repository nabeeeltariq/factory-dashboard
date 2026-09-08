// netlify/functions/archive-shift.js

const FIREBASE_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_data.json';
const HOURLY_URL = 'https://automation-60207-default-rtdb.firebaseio.com/hourly_production.json';
const BREAKDOWN_LOG_URL = 'https://automation-60207-default-rtdb.firebaseio.com/breakdowns.json';
const ADJUSTMENTS_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_adjustments.json';
const TIMESTAMPS_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_timestamps.json';
const SHIFT_HISTORY_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_history.json';
const RESET_COMMAND_URL = 'https://automation-60207-default-rtdb.firebaseio.com/reset_command.json';

export default async (req) => {
    // 1. Fetch all raw live data from Firebase
    try {
        const [shiftRes, hourlyRes, breakdownRes, adjustmentsRes, timestampsRes] = await Promise.all([
            fetch(FIREBASE_URL),
            fetch(HOURLY_URL),
            fetch(BREAKDOWN_LOG_URL),
            fetch(ADJUSTMENTS_URL),
            fetch(TIMESTAMPS_URL)
        ]);

        const shiftData = shiftRes.ok ? await shiftRes.json() : null;
        const hourlyDataRaw = hourlyRes.ok ? await hourlyRes.json() : null;
        const breakdownDataRaw = breakdownRes.ok ? await breakdownRes.json() : null;
        const adjustmentsData = adjustmentsRes.ok ? await adjustmentsRes.json() : null;
        const timestampsData = timestampsRes.ok ? await timestampsRes.json() : null;

        // Apply manual adjustments
        const adjTotal = (adjustmentsData && adjustmentsData.total) || 0;
        const adjHourly = (adjustmentsData && adjustmentsData.hourly) || {};

        const totalCases = Math.max(0, ((shiftData && shiftData.total_cases) || 0) + adjTotal);
        const totalDowntimeSeconds = (shiftData && shiftData.breakdown_seconds) || 0;

        const hourlyProduction = {};
        if (hourlyDataRaw) {
            Object.keys(hourlyDataRaw).forEach((key) => {
                const value = (hourlyDataRaw[key] || 0) + (adjHourly[key] || 0);
                hourlyProduction[key] = Math.max(0, value);
            });
        }

        let breakdowns = [];
        if (breakdownDataRaw) {
            breakdowns = Object.values(breakdownDataRaw)
                .map((record) => ({ start: record.start * 1000, duration: record.duration }))
                .sort((a, b) => a.start - b.start);
        }

        const shiftStart = (timestampsData && timestampsData.start) || null;
        const shiftEnd = Date.now(); // Mark the end time as right now

        const d = new Date(shiftStart || Date.now());
        const dateLabel = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

        // Assemble the final snapshot
        const snapshot = {
            date: dateLabel,
            shift_start: shiftStart,
            shift_end: shiftEnd,
            total_cases: totalCases,
            total_downtime_seconds: totalDowntimeSeconds,
            breakdown_count: breakdowns.length,
            hourly_production: hourlyProduction,
            breakdowns: breakdowns,
            saved_at: Date.now(),
            report: null // Ready for the OEE wizard later
        };

        // 2. Permanently save to Production History
        const saveRes = await fetch(SHIFT_HISTORY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot)
        });

        if (!saveRes.ok) {
            throw new Error('Failed to save to shift history');
        }

        // 3. Send Hardware Reset Command to ESP32
        await fetch(RESET_COMMAND_URL, {
            method: 'PUT',
            body: 'true'
        });

        // 4. Wipe temporary live nodes silently in the background
        await Promise.allSettled([
            fetch(FIREBASE_URL, { method: 'DELETE' }),
            fetch(HOURLY_URL, { method: 'DELETE' }),
            fetch(ADJUSTMENTS_URL, { method: 'DELETE' }),
            fetch(TIMESTAMPS_URL, { method: 'DELETE' })
        ]);

        return new Response(JSON.stringify({ success: true, message: "Shift successfully archived by Netlify webhook." }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error("Archive Error:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
};
