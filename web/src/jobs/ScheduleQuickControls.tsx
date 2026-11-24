import * as schedulingModule from './scheduling';

export type ScheduleQuickControlsProps = {
  value: string;
  durationMinutes?: number | null;
  disabled?: boolean;
  onSelect: (localValue: string) => void;
  showPastHint?: boolean;
  showSundayHint?: boolean;
};

/**
 * Reusable quick-preset chips, live canonical duration preview, and calm
 * non-blocking advisory hints (Sunday / past-start) paired with a standard
 * `<input type="datetime-local">` control.
 */
export function ScheduleQuickControls({
  value,
  durationMinutes,
  disabled = false,
  onSelect,
  showPastHint = true,
  showSundayHint = true,
}: ScheduleQuickControlsProps) {
  // Shallow-copy own exports so legacy test files mocking `../src/jobs/scheduling`
  // without `importOriginal` do not fail on Vitest's missing-export proxy trap.
  const schedulingApi = { ...schedulingModule } as Partial<typeof schedulingModule>;
  const presets = typeof schedulingApi.buildQuickSchedulePresets === 'function'
    ? schedulingApi.buildQuickSchedulePresets()
    : [];
  const preview = value && durationMinutes != null && durationMinutes > 0
    && typeof schedulingApi.formatPlannedDurationPreview === 'function'
    ? schedulingApi.formatPlannedDurationPreview(value, durationMinutes)
    : null;
  const sundayHint = showSundayHint && Boolean(value)
    && typeof schedulingApi.isLocalSunday === 'function' && schedulingApi.isLocalSunday(value);
  const pastHint = showPastHint && Boolean(value)
    && typeof schedulingApi.isLocalPast === 'function' && schedulingApi.isLocalPast(value);

  if (presets.length === 0 && !preview && !sundayHint && !pastHint) {
    return null;
  }

  return (
    <>
      {presets.length > 0 && (
        <div className="schedule-quick-chips" role="group" aria-label="Hızlı zaman seçenekleri">
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className="schedule-quick-chip"
              disabled={disabled}
              aria-pressed={value === preset.value}
              onClick={() => {
                if (!disabled) onSelect(preset.value);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
      {preview && (
        <p className="schedule-duration-preview">Planlanan aralık: {preview}</p>
      )}
      {sundayHint && (
        <p className="schedule-advisory-hint" role="status">
          Pazar günü çalışma günü dışıdır; yine de planlayabilirsiniz.
        </p>
      )}
      {pastHint && (
        <p className="schedule-advisory-hint" role="status">
          Seçilen zaman geçmişte görünüyor; kayıt sırasında ek onay istenebilir.
        </p>
      )}
    </>
  );
}
