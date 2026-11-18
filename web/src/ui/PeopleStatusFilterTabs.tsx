export type PeopleStatusFilter = 'active' | 'inactive' | 'all';

const options: ReadonlyArray<{ value: PeopleStatusFilter; label: string }> = [
  { value: 'active', label: 'Aktif' },
  { value: 'inactive', label: 'Pasif' },
  { value: 'all', label: 'Tümü' },
];

/** Active / inactive / all selector shared by the user list and the staff directory. */
export function PeopleStatusFilterTabs({ value, onChange, label }: {
  value: PeopleStatusFilter; onChange: (next: PeopleStatusFilter) => void; label: string;
}) {
  return <div className="history-tabs" role="tablist" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" role="tab" aria-selected={value === option.value}
      className={value === option.value ? 'secondary-button is-active' : 'secondary-button'}
      onClick={() => { if (value !== option.value) onChange(option.value); }}>{option.label}</button>)}
  </div>;
}
