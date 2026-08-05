// client/src/attendancemodule/usePeriods.js
//
// Shared hook — the one place period timings come from.
//
// Period start/end times are admin-editable in Acquisition Control and stored
// on the AcquisitionControl document. Four pages used to hard-code their own
// SLOT_LABELS map with the times baked into the string, so editing a period
// changed nothing anywhere in the UI (and the four copies had already drifted
// apart from each other). Anything that shows a period label reads it here.

import { useState, useEffect, useCallback } from 'react';
import getEnvironment from '../getenvironment';
import { formatSlotLabel, PERIOD_KEYS } from './config';

const AC_CONFIG_API = `${getEnvironment()}/attendancemodule/acquisitioncontrol`;

export function usePeriods() {
    const [periods, setPeriods] = useState([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(AC_CONFIG_API, { credentials: 'include' })
            .then((r) => r.json())
            .then((data) => {
                if (cancelled) return;
                setPeriods(Array.isArray(data?.periods) ? data.periods : []);
                setLoaded(true);
            })
            .catch(() => {
                // Labels degrade to bare names ("Period 1") — never blank.
                if (!cancelled) setLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const slotLabel = useCallback(
        (periodKey) => formatSlotLabel(periodKey, periods),
        [periods],
    );

    // Keys in display order. Periods the admin has configured come first in
    // their configured order; any remaining known keys follow.
    const slotKeys = periods.length
        ? periods.map((p) => p.periodKey).filter(Boolean)
        : PERIOD_KEYS;

    return { periods, slotLabel, slotKeys, loaded };
}

export default usePeriods;
