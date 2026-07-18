import { useId, type ReactNode } from 'react';

export type OperationalTableColumn = Readonly<{
  key: string;
  title: string;
}>;

export type OperationalTableRow = Readonly<{
  key: string;
  cells: Readonly<Record<string, ReactNode>>;
}>;

export type OperationalTableProps = Readonly<{
  caption: string;
  columns: readonly OperationalTableColumn[];
  rows: readonly OperationalTableRow[];
}>;

/**
 * Servora-native dense report table with a real mobile card alternative at max-width 720px.
 * Not an Ant Design adapter: Delivery needs semantic dual layout without Table sorting.
 * Ant Table remains selective for future admin/sortable surfaces.
 * Feature prepares columns/cells; this component does not call APIs or compute metrics.
 */
export function OperationalTable({
  caption,
  columns,
  rows,
}: OperationalTableProps): ReactNode {
  const mobileCaptionId = useId();

  return (
    <div className="servora-operational-table" data-servora-operational-table="true">
      <table className="report-table servora-operational-table__desktop">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">{column.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {columns.map((column, index) => {
                const value = row.cells[column.key] ?? '';
                if (index === 0) {
                  return (
                    <th key={column.key} scope="row">{value}</th>
                  );
                }
                return <td key={column.key}>{value}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="servora-operational-table__mobile">
        <p
          id={mobileCaptionId}
          className="servora-operational-table__mobile-caption"
        >
          {caption}
        </p>
        <ul aria-labelledby={mobileCaptionId}>
          {rows.map((row) => (
            <li key={row.key} className="servora-operational-table__card">
              <dl>
                {columns.map((column) => (
                  <div key={column.key} className="servora-operational-table__field">
                    <dt>{column.title}</dt>
                    <dd>{row.cells[column.key] ?? ''}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
