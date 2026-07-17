const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const SERVER_NAME_TO_CLIENT_MAP = new Map();
const TOOL_TO_SERVER_NAME = new Map();
let handlersRegistered = false;

function resolveMcpArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }

  const rootCandidates = [
    process.cwd(),
    app.getAppPath && app.getAppPath(),
    process.resourcesPath && path.join(process.resourcesPath, 'app'),
    process.resourcesPath,
  ].filter(Boolean);

  return args.map((arg) => {
    if (typeof arg !== 'string' || !arg || path.isAbsolute(arg)) {
      return arg;
    }

    for (const root of rootCandidates) {
      const candidate = path.resolve(root, arg);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return arg;
  });
}

function mapSdkToolToRendererShape(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

async function listServerTools(serverName) {
  if (!serverName) {
    return [];
  }

  const clientEntry = SERVER_NAME_TO_CLIENT_MAP.get(serverName);
  if (!clientEntry) {
    return [];
  }

  const toolsResult = await clientEntry.client.listTools();
  clientEntry.tools = toolsResult.tools;
  return toolsResult.tools.map((tool) => {
    TOOL_TO_SERVER_NAME.set(tool.name, serverName);
    return mapSdkToolToRendererShape(tool);
  });
}

async function connectToServer(name, command, args) {
  if (SERVER_NAME_TO_CLIENT_MAP.has(name)) {
    return { success: true };
  }

  const mcpClient = new Client({
    name: `mcp-client_${name}`,
    version: '1.0.0',
  });

  const mcpTransport = new StdioClientTransport({
    command,
    args: resolveMcpArgs(args),
  });

  await mcpClient.connect(mcpTransport);
  SERVER_NAME_TO_CLIENT_MAP.set(name, { client: mcpClient, transport: mcpTransport, tools: [] });
  return { success: true };
}

async function listTools(serverName) {
  return {
    success: true,
    tools: await listServerTools(serverName),
  };
}

async function useTool(toolName, args) {
  const serverName = TOOL_TO_SERVER_NAME.get(toolName);
  const clientEntry = SERVER_NAME_TO_CLIENT_MAP.get(serverName);
  if (!clientEntry) {
    throw new Error(`Tool ${toolName} is not available.`);
  }

  const tool = Array.isArray(clientEntry.tools)
    ? clientEntry.tools.find((item) => item.name === toolName)
    : null;
  if (!tool) {
    throw new Error(`Tool ${toolName} not found.`);
  }

  const result = await clientEntry.client.callTool({
    name: toolName,
    arguments: args,
  });
  return { success: true, result };
}

function registerMCPHandlers(mainWindow) {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  ipcMain.handle('mcp:connect', async (_event, name, command, args) => {
    try {
      return await connectToServer(name, command, args);
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:get-tools', async (_event, name) => {
    try {
      return await listTools(name);
    } catch (error) {
      console.error('Failed to get MCP tools:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mcp:use-tool', async (_event, toolName, args) => {
    try {
      return await useTool(toolName, args);
    } catch (error) {
      console.error('Failed to use MCP tool:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerMCPHandlers,
};
