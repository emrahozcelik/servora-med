/**
 * Back-compat re-export: filter call sites keep FilterSheet name;
 * implementation is ResponsiveDrawer under the owned boundary.
 */
export {
  ResponsiveDrawer as FilterSheet,
  type ResponsiveDrawerProps as FilterSheetProps,
} from './antd/ResponsiveDrawer';

export function countTruthy(values: Array<string | boolean | undefined | null>): number {
  return values.filter((value) => {
    if (value === undefined || value === null || value === false || value === '') return false;
    return true;
  }).length;
}
