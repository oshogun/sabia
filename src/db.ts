// The domain modules, re-exported so './db' stays the single import surface for
// the rest of the server. ./db/schema is deliberately absent: applySchema is
// initDb's business and nothing outside the connection module may call it.
//
// Nothing else lives here. Add a function to the module that owns its tables,
// not to this barrel.
export * from './db/connection';
export * from './db/flights';
export * from './db/trips';
export * from './db/plannedLegs';
export * from './db/settings';
export * from './db/acarsMessages';
export * from './db/ingestTokens';
export * from './db/mcpTokens';
