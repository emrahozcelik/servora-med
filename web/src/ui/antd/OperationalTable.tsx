import type { ReactNode } from 'react';

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
 * Render-only dense table with a real mobile card alternative at max-width 720px.
 * Feature prepares columns/cells; this adapter does not call APIs or compute metrics.
 */
export function OperationalTable({
  caption,
  columns,
  rows,
}: OperationalTableProps): ReactNode {
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

      <ul
        className="servora-operational-table__mobile"
        aria-label={caption}
      >
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
  );
}
