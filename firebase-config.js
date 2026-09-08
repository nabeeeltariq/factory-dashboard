// =====================================================================
// SHARED CONFIG — loaded by both index.html and history.html.
// =====================================================================

const FIREBASE_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_data.json';
const HOURLY_URL = 'https://automation-60207-default-rtdb.firebaseio.com/hourly_production.json';
const BREAKDOWN_LOG_URL = 'https://automation-60207-default-rtdb.firebaseio.com/breakdowns.json';
const SHIFT_CONTROL_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_control.json';
const ADJUSTMENTS_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_adjustments.json';
const TIMESTAMPS_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_timestamps.json';
const SHIFT_HISTORY_URL = 'https://automation-60207-default-rtdb.firebaseio.com/shift_history.json';
const SHIFT_HISTORY_BASE = 'https://automation-60207-default-rtdb.firebaseio.com/shift_history';
const RESET_COMMAND_URL = 'https://automation-60207-default-rtdb.firebaseio.com/reset_command.json';

// Updated with Weight (grams) and Pack Size (pieces/case) for Tonnage Math
const VARIANTS = [
    { name: 'LUX Soft Rose 120GM', cpm: 1.666, weight: 120, packSize: 72 },
    { name: 'LUX Soft Rose 170GM', cpm: 2.5, weight: 170, packSize: 48 },
    { name: 'LUX Velvet Jasmine 120GM', cpm: 1.666, weight: 120, packSize: 72 },
    { name: 'LUX Velvet Jasmine 170GM', cpm: 2.5, weight: 170, packSize: 48 },
    { name: 'LUX Creamy Perfection 120GM', cpm: 1.666, weight: 120, packSize: 72 },
    { name: 'LUX Creamy Perfection 170GM', cpm: 2.5, weight: 170, packSize: 48 },
    { name: 'LUX Gardenia Blossom 120GM', cpm: 1.666, weight: 120, packSize: 72 },
    { name: 'LUX Gardenia Blossom 170GM', cpm: 2.5, weight: 170, packSize: 48 },
    { name: 'Lifebuoy TOTAL10 125GM', cpm: 1.666, weight: 125, packSize: 72 },
    { name: 'Lifebuoy TOTAL10 160GM', cpm: 2.5, weight: 160, packSize: 48 },
    { name: 'Lifebuoy Mild Care 125GM', cpm: 1.666, weight: 125, packSize: 72 },
    { name: 'Lifebuoy Mild Care 160GM', cpm: 2.5, weight: 160, packSize: 48 }
];