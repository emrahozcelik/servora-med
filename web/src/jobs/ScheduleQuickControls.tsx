import {
  buildQuickSchedulePresets,
  formatPlannedDurationPreview,
  isLocalPast,
  isLocalSunday,
} from './scheduling';

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
 * non-blocking advisory hints (Sunday / past-start) paired with the shared
 * `WheelDateTimeField` control.
 */
export function ScheduleQuickControls({
  value,
  durationMinutes,
  disabled = false,
  onSelect,
  showPastHint = true,
  showSundayHint = true,
}: ScheduleQuickControlsProps) {
  const presets = buildQuickSchedulePresets();
  const preview = value && durationMinutes != null && durationMinutes > 0
    ? formatPlannedDurationPreview(value, durationMinutes)
    : null;
  const sundayHint = showSundayHint && Boolean(value) && isLocalSunday(value);
  const pastHint = showPastHint && Boolean(value) && isLocalPast(value);

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
