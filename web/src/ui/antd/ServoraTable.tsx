import { Table, type TableProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';

export type ServoraTableProps<RecordType extends object> = TableProps<RecordType>;
export type ServoraTableColumnsType<RecordType> = ColumnsType<RecordType>;

export function ServoraTable<RecordType extends object>(props: ServoraTableProps<RecordType>) {
  return <Table<RecordType> {...props} />;
}
