(function initRecordingSchedule(globalScope) {
  const MODE_NONE = 'none';
  const MODE_AT_TIME = 'at_time';
  const MODE_AFTER_INTERVAL = 'after_interval';

  function createDisabledSchedule() {
    return { mode: MODE_NONE };
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function toInteger(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  function parseTimeValue(timeValue) {
    if (typeof timeValue !== 'string') {
      throw new Error('Choose a stop time.');
    }

    const match = /^(\d{1,2}):(\d{2})$/.exec(timeValue.trim());
    if (!match) {
      throw new Error('Choose a valid stop time.');
    }

    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error('Choose a valid stop time.');
    }

    return {
      hours,
      minutes,
      timeValue: `${pad2(hours)}:${pad2(minutes)}`,
    };
  }

  function normalizeDurationParts(hoursInput, minutesInput) {
    const rawHours = toInteger(hoursInput);
    const rawMinutes = toInteger(minutesInput);

    if (rawHours === null || rawMinutes === null || rawHours < 0 || rawMinutes < 0) {
      throw new Error('Enter a valid stop interval.');
    }

    const totalMinutes = (rawHours * 60) + rawMinutes;
    if (totalMinutes <= 0) {
      throw new Error('Stop interval must be greater than zero.');
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return {
      hours,
      minutes,
      totalMinutes,
      durationMs: totalMinutes * 60 * 1000,
    };
  }

  function formatDurationWords(hours, minutes) {
    const parts = [];
    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    if (minutes > 0) {
      parts.push(`${minutes}m`);
    }
    return parts.join(' ') || '0m';
  }

  function buildStopAtTimeOption(timeValue) {
    const parsed = parseTimeValue(timeValue);
    return {
      mode: MODE_AT_TIME,
      hours: parsed.hours,
      minutes: parsed.minutes,
      timeValue: parsed.timeValue,
    };
  }

  function buildStopAfterIntervalOption(hoursInput, minutesInput) {
    const parsed = normalizeDurationParts(hoursInput, minutesInput);
    return {
      mode: MODE_AFTER_INTERVAL,
      hours: parsed.hours,
      minutes: parsed.minutes,
      durationMs: parsed.durationMs,
      durationLabel: formatDurationWords(parsed.hours, parsed.minutes),
    };
  }

  function cloneSchedule(schedule) {
    if (!schedule || schedule.mode === MODE_NONE) {
      return createDisabledSchedule();
    }

    if (schedule.mode === MODE_AT_TIME) {
      const normalized = buildStopAtTimeOption(
        typeof schedule.timeValue === 'string'
          ? schedule.timeValue
          : `${pad2(schedule.hours)}:${pad2(schedule.minutes)}`
      );
      if (Number.isFinite(schedule.targetTs)) {
        normalized.targetTs = schedule.targetTs;
      }
      return normalized;
    }

    if (schedule.mode === MODE_AFTER_INTERVAL) {
      const normalized = buildStopAfterIntervalOption(schedule.hours, schedule.minutes);
      if (Number.isFinite(schedule.remainingMs)) {
        normalized.remainingMs = Math.max(0, schedule.remainingMs);
      }
      if (Number.isFinite(schedule.targetTs)) {
        normalized.targetTs = schedule.targetTs;
      }
      return normalized;
    }

    return createDisabledSchedule();
  }

  function normalizeScheduleOption(schedule) {
    return cloneSchedule(schedule);
  }

  function computeNextAbsoluteTarget(hours, minutes, now = Date.now()) {
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  function activateSchedule(schedule, now = Date.now(), overrides = {}) {
    const normalized = normalizeScheduleOption(schedule);
    if (normalized.mode === MODE_NONE) {
      return normalized;
    }

    if (normalized.mode === MODE_AT_TIME) {
      return {
        ...normalized,
        targetTs: Number.isFinite(overrides.targetTs)
          ? overrides.targetTs
          : computeNextAbsoluteTarget(normalized.hours, normalized.minutes, now),
      };
    }

    const remainingMs = Number.isFinite(overrides.remainingMs)
      ? Math.max(0, overrides.remainingMs)
      : normalized.durationMs;

    return {
      ...normalized,
      remainingMs,
      targetTs: Number.isFinite(overrides.targetTs)
        ? overrides.targetTs
        : now + remainingMs,
    };
  }

  function pauseActiveSchedule(schedule, now = Date.now()) {
    const current = cloneSchedule(schedule);
    if (current.mode !== MODE_AFTER_INTERVAL) {
      return current;
    }

    const remainingMs = Number.isFinite(current.targetTs)
      ? Math.max(0, current.targetTs - now)
      : Number.isFinite(current.remainingMs)
        ? Math.max(0, current.remainingMs)
        : current.durationMs;

    delete current.targetTs;
    current.remainingMs = remainingMs;
    return current;
  }

  function resumeActiveSchedule(schedule, now = Date.now()) {
    const current = cloneSchedule(schedule);
    if (current.mode !== MODE_AFTER_INTERVAL) {
      return current;
    }

    const remainingMs = Number.isFinite(current.remainingMs)
      ? Math.max(0, current.remainingMs)
      : current.durationMs;

    current.remainingMs = remainingMs;
    current.targetTs = now + remainingMs;
    return current;
  }

  function getAlarmTarget(schedule) {
    const current = cloneSchedule(schedule);
    return Number.isFinite(current.targetTs) ? current.targetTs : null;
  }

  function isScheduleEnabled(schedule) {
    return Boolean(schedule && schedule.mode && schedule.mode !== MODE_NONE);
  }

  function formatClockTime(targetTs) {
    const date = targetTs instanceof Date ? targetTs : new Date(targetTs);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function formatDurationMs(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => pad2(value)).join(':');
  }

  function describeSchedule(schedule, options = {}) {
    const current = cloneSchedule(schedule);
    const state = options.state || 'IDLE';
    const now = Number.isFinite(options.now) ? options.now : Date.now();

    if (current.mode === MODE_NONE) {
      return '';
    }

    if (current.mode === MODE_AT_TIME) {
      const targetTs = Number.isFinite(current.targetTs)
        ? current.targetTs
        : computeNextAbsoluteTarget(current.hours, current.minutes, now);
      return `Auto-stop at ${formatClockTime(targetTs)}`;
    }

    const isPausedState = state === 'PAUSED' || state === 'LIMIT_PAUSED';
    const remainingMs = (Number.isFinite(current.targetTs) && !isPausedState)
      ? Math.max(0, current.targetTs - now)
      : Number.isFinite(current.remainingMs)
        ? Math.max(0, current.remainingMs)
        : current.durationMs;

    return `Auto-stop in ${formatDurationMs(remainingMs)}${isPausedState ? ' (paused)' : ''}`;
  }

  const api = {
    MODE_NONE,
    MODE_AT_TIME,
    MODE_AFTER_INTERVAL,
    activateSchedule,
    buildStopAfterIntervalOption,
    buildStopAtTimeOption,
    cloneSchedule,
    computeNextAbsoluteTarget,
    createDisabledSchedule,
    describeSchedule,
    formatClockTime,
    formatDurationMs,
    getAlarmTarget,
    isScheduleEnabled,
    normalizeScheduleOption,
    pauseActiveSchedule,
    resumeActiveSchedule,
  };

  globalScope.RecordingSchedule = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
