import express, { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpConfig } from '../config';
import type { FlightManager } from '../flightManager';
import { createMcpTokenGate, assertToolRoutesAreScoped } from '../auth/mcpScope';
import { buildMcpServer, MCP_TOOLS } from './server';

const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method Not Allowed: this MCP endpoint is stateless and accepts POST only' },
  id: null,
};

/**
 * POST /mcp behind createMcpTokenGate; GET and DELETE (and everything else)
 * answer 405 — a stateless server has no server-initiated stream to offer,
 * and the MCP spec explicitly allows 405 for a GET the server doesn't
 * support. Always mounted, regardless of whether any MCP credential is
 * configured: createMcpTokenGate itself decides whether a request reaches
 * this router at all.
 */
export function createMcpRouter(mcp: McpConfig, flightManager: FlightManager, onChanged: () => void = () => {}): Router {
  // Startup assertion, run once here rather than per request: this is what
  // keeps MCP_SCOPED_ROUTES load-bearing even though every tool handler below
  // calls an in-process function instead of going through this router.
  assertToolRoutesAreScoped(MCP_TOOLS);

  const router = express.Router();
  router.use(createMcpTokenGate(mcp));

  router.post('/', async (req, res) => {
    // Fresh server and transport per request (stateless mode): one operator,
    // a handful of concurrent clients at most, and nothing any tool returns
    // needs a resumable stream or a server-initiated notification.
    const server = buildMcpServer(flightManager, onChanged);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // express.json() has already parsed the body; handed to the transport
    // explicitly, the SDK's documented path for a body-parser'd app.
    await transport.handleRequest(req, res, req.body);
  });

  router.all('/', (_req, res) => {
    res.status(405).set('Allow', 'POST').json(METHOD_NOT_ALLOWED_BODY);
  });

  return router;
}
