import { registerConnector } from './registry.js';
import { installedSqlConnector } from './drivers/sql-connector.js';

const parts = Array.from(
  { length: 16 },
  (_, index) => `SELECT t.owner,t.tabname,c.constrname,c.constrtype,
  col.colname,${index + 1} AS position FROM systables t
  JOIN sysconstraints c ON c.tabid=t.tabid JOIN sysindexes i ON i.tabid=c.tabid AND i.idxname=c.idxname
  JOIN syscolumns col ON col.tabid=t.tabid AND col.colno=ABS(i.part${index + 1})
  WHERE c.constrtype IN ('P','U')`,
).join(' UNION ALL ');

export const informixConnector = installedSqlConnector('informix', {
  version: "SELECT FIRST 1 DBINFO('version','full') AS version FROM systables",
  objects: `SELECT owner AS schema_name,tabname AS name,tabtype AS type,
    CASE WHEN tabtype='V' THEN NULL ELSE nrows END AS estimate FROM systables
    WHERE tabid>=100 AND tabtype IN ('T','V') ORDER BY owner,tabname`,
  keys: (schema) => `SELECT constrname AS constraint_name,colname AS column_name FROM (${parts}) AS keys
    WHERE owner=${schema ? '?' : 'USER'} AND tabname=?
    ORDER BY CASE WHEN constrtype='P' THEN 0 ELSE 1 END,constrname,position`,
  // DRDA carries a BOOLEAN as a SMALLINT, so the catalog says which columns are booleans: the
  // built-in opaque type named boolean, or type 45 on a server that numbers it that way.
  booleans: (schema) => `SELECT c.colname AS column_name FROM syscolumns c JOIN systables t ON t.tabid=c.tabid
    WHERE t.owner=${schema ? '?' : 'USER'} AND t.tabname=? AND (MOD(c.coltype,256)=45
    OR c.extended_id IN (SELECT x.extended_id FROM sysxtdtypes x WHERE x.name='boolean'))`,
});
registerConnector(informixConnector);
