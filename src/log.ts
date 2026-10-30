// All logging goes to stderr: in stdio mode stdout carries the MCP protocol.

export const log = (...args: unknown[]) => console.error(...args);
