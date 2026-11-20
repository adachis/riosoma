import { registerConnector } from './registry.js';
import { installedSqlConnector } from './drivers/sql-connector.js';

export const teradataConnector = installedSqlConnector('teradata', {
  version: "SELECT InfoData AS version FROM DBC.DBCInfoV WHERE InfoKey='VERSION'",
  objects: `SELECT t.DatabaseName AS schema_name,t.TableName AS name,t.TableKind AS type,
    CASE WHEN t.TableKind='V' THEN NULL ELSE s.RowCount END AS estimate
    FROM DBC.TablesVX t LEFT JOIN (
      SELECT DatabaseName,TableName,MAX(RowCount) AS RowCount FROM DBC.TableStatsV
      GROUP BY DatabaseName,TableName
    ) s
    ON s.DatabaseName=t.DatabaseName AND s.TableName=t.TableName
    WHERE t.TableKind IN ('T','O','V') AND t.DatabaseName NOT IN ('DBC','Sys_Calendar','SYSUIF')
    ORDER BY t.DatabaseName,t.TableName`,
  keys: (schema) => `SELECT IndexNumber AS constraint_name,ColumnName AS column_name FROM DBC.IndicesV
    WHERE DatabaseName=${schema ? '?' : 'DATABASE'} AND TableName=? AND UniqueFlag='Y'
    ORDER BY CASE WHEN IndexType='K' THEN 0 ELSE 1 END,IndexNumber,ColumnPosition`,
});
registerConnector(teradataConnector);
