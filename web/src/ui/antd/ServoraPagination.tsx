import { Pagination, type PaginationProps } from 'antd';

export type ServoraPaginationProps = PaginationProps;

export function ServoraPagination(props: ServoraPaginationProps) {
  return <Pagination {...props} />;
}
