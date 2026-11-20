/**
 * The part of node-oracledb's API the Oracle connector uses.  The package ships no types of its
 * own, and its thin mode is all Riosoma loads.
 */
declare module 'oracledb' {
  namespace oracledb {
    interface DbType {
      readonly num: number;
      readonly name: string;
    }
    interface Metadata {
      name: string;
      dbType: DbType;
      dbTypeName?: string;
      precision?: number;
      scale?: number;
      byteSize?: number;
      nullable?: boolean;
    }
    interface ResultSet<T> {
      getRows(count: number): Promise<T[]>;
      close(): Promise<void>;
    }
    interface Result<T> {
      rows?: T[];
      metaData?: Metadata[];
      resultSet?: ResultSet<T>;
    }
    interface FetchType {
      type: unknown;
    }
    interface ExecuteOptions {
      outFormat?: number;
      resultSet?: boolean;
      fetchArraySize?: number;
      prefetchRows?: number;
      maxRows?: number;
      fetchTypeHandler?(metaData: Metadata): FetchType | undefined;
    }
    interface Connection {
      callTimeout: number;
      readonly oracleServerVersionString: string;
      execute<T>(sql: string, binds?: readonly unknown[], options?: ExecuteOptions): Promise<Result<T>>;
      break(): Promise<void>;
      rollback(): Promise<void>;
      close(): Promise<void>;
    }
    interface ConnectionAttributes {
      user: string;
      password?: string;
      connectString: string;
      /** Seconds to reach the listener and finish connecting */
      connectTimeout?: number;
      /** Seconds to open the socket */
      transportConnectTimeout?: number;
      retryCount?: number;
      stmtCacheSize?: number;
      /** An HTTP proxy for TCPS, which keeps the driver from resolving the host, and where the connector puts its route token */
      httpsProxy?: string;
      /** Whether the certificate has to name the descriptor's host */
      sslServerDNMatch?: boolean;
      /** A PEM wallet: a client certificate and key, then the certificates to trust */
      walletContent?: string;
    }
  }
  const oracledb: {
    getConnection(attributes: oracledb.ConnectionAttributes): Promise<oracledb.Connection>;
    readonly thin: boolean;
    readonly OUT_FORMAT_OBJECT: number;
    readonly STRING: unknown;
    readonly DB_TYPE_NUMBER: oracledb.DbType;
    readonly DB_TYPE_CLOB: oracledb.DbType;
    readonly DB_TYPE_NCLOB: oracledb.DbType;
  };
  export = oracledb;
}

/** The driver's TCP transport, whose `connect` opens every socket it uses, redirects included. */
declare module 'oracledb/lib/thin/sqlnet/ntTcp.js' {
  class NTTCP {
    constructor(atts?: Record<string, unknown>);
    connect(address: unknown): Promise<void>;
  }
  export = NTTCP;
}

/** The driver's reader for connect descriptors, which tests use to see what it makes of one. */
declare module 'oracledb/lib/thin/sqlnet/connStrategy.js' {
  export function createNode(
    text: string,
    userConfig: Record<string, unknown>,
  ): Promise<{
    descriptionList: Array<{
      cOpts: Array<{ hostname: string; host: string; port: number; protocol: string }>;
    }>;
  }>;
}
