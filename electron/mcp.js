// import { app, BrowserWindow, ipcMain } from 'electron';
// import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { ipcMain } = require("electron");

const ServerNameToClientMap = new Map();
const toolToServerName = new Map();


// 设置IPC处理器
function registerMCPHandlers() {
    ipcMain.handle('mcp:connect', async (event, name, command, args) => {
        try {
            // 检查是否已经连接
            if (ServerNameToClientMap.has(name)) {
                console.warn(`MCP client with name ${name} is already connected.`);
                return { success: true };
            }   

            const mcpClient = new Client({
                name: `mcp-client_${name}`,
                version: "1.0.0",
            });

            const mcpTransport = new StdioClientTransport({
                command,
                args,
            });

            // console.log("mcpTransport: ", mcpTransport);
            await mcpClient.connect(mcpTransport);
            ServerNameToClientMap.set(name, { client: mcpClient, transport: mcpTransport });

            return { success: true };
        } catch (e) {
            console.error("Failed to connect to MCP server:", e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('mcp:get-tools', async (event, name) => {
        try {
            const mcpClientObj = ServerNameToClientMap.get(name);
            if (!mcpClientObj) {
                throw new Error("MCP client is not connected");
            }

            const mcpClient = mcpClientObj.client;

            const toolsResult = await mcpClient.listTools();
            // toolsResult存入 ServerNameToClientMap
            mcpClientObj.tools = toolsResult.tools;
            let tools = toolsResult.tools.map((tool) => {
                toolToServerName.set(tool.name, name);
                return {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                };
            });

            console.log("Connected to MCP server with tools:", tools.map(({ name }) => name));
            return { success: true, tools };
        } catch (e) {
            console.error("Failed to get MCP tools:", e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('mcp:use-tool', async (event, toolName, args) => {
        try {
            const ServerName = toolToServerName.get(toolName);
            const mcpClientObj = ServerNameToClientMap.get(ServerName);

            if (!mcpClientObj) {
                throw new Error("MCP client is not connected");
            }
            const mcpTransport = mcpClientObj.transport;
            const mcpClient = mcpClientObj.client;

            const tools = mcpClientObj.tools
            // console.log("tools: ", tools);

            if (!mcpTransport) {
                throw new Error("MCP transport is not connected");
            }

            const tool = tools.find((t) => t.name === toolName);
            if (!tool) {
                throw new Error(`Tool ${toolName} not found`);
            }

            const result = await mcpClient.callTool({
                name: toolName,
                arguments: args,
            });

            return { success: true, result };
        } catch (e) {
            console.error("Failed to use MCP tool:", e);
            return { success: false, error: e.message };
        }
    });
}


module.exports = {
    registerMCPHandlers,
}