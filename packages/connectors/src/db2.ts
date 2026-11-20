import { registerConnector } from './registry.js';
import { installedSqlConnector } from './drivers/sql-connector.js';

export const db2Connector = installedSqlConnector('db2', {
  // The catalog's own record of the release, which any user who can connect may read.  The
  // instance's information comes from a fenced routine, which fails where fenced routines can't run.
  version: `SELECT 'Db2 ' || TRIM(CHAR(VERSIONNUMBER / 1000000)) || '.' ||
    TRIM(CHAR(MOD(VERSIONNUMBER / 10000, 100))) || '.' || TRIM(CHAR(MOD(VERSIONNUMBER / 100, 100))) || '.' ||
    TRIM(CHAR(MOD(VERSIONNUMBER, 100))) AS version FROM SYSIBM.SYSVERSIONS
    ORDER BY VERSION_TIMESTAMP DESC FETCH FIRST 1 ROW ONLY`,
  objects: `SELECT TABSCHEMA AS schema_name,TABNAME AS name,TYPE AS type,
    CASE WHEN TYPE='V' THEN NULL ELSE CARD END AS estimate FROM SYSCAT.TABLES
    WHERE TYPE IN ('T','V') AND TABSCHEMA NOT LIKE 'SYS%' ORDER BY TABSCHEMA,TABNAME`,
  keys: (schema) => `SELECT c.CONSTNAME AS constraint_name,k.COLNAME AS column_name FROM SYSCAT.TABCONST c
    JOIN SYSCAT.KEYCOLUSE k ON k.TABSCHEMA=c.TABSCHEMA AND k.TABNAME=c.TABNAME AND k.CONSTNAME=c.CONSTNAME
    WHERE c.TABSCHEMA=${schema ? '?' : 'CURRENT SCHEMA'} AND c.TABNAME=? AND c.TYPE IN ('P','U')
    ORDER BY CASE WHEN c.TYPE='P' THEN 0 ELSE 1 END,c.CONSTNAME,k.COLSEQ`,
});
registerConnector(db2Connector);
