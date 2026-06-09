/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import * as http from 'http';
import { Orchestrator } from './momoa_core/orchestrator.js';
import { Config, DEFAULT_GEMINI_EMBEDDING_MODEL } from './config/config.js';
import { AuthType } from './services/contentGenerator.js';
import { randomUUID } from 'crypto';
import { isBinaryFileSync } from 'isbinaryfile';
import { ServerMode, UserSecrets } from './shared/model.js';
import { ProgressQueue } from './utils/progressQueue.js';

// --- Type Definitions ---
/**
 * Defines the structure for incoming WebSocket messages.
 */
interface WebSocketMessage {
  status: 'INITIAL_REQUEST_PARAMS' | 'FILE_CHUNK' | 'START_TASK' | 'HITL_RESPONSE' | string;
  data?: any;
  messageId?: string;
  answer?: any;
}

/**
 * Defines the structure for the data in an 'INITIAL_REQUEST_PARAMS' message,
 * matching the Python client's payload but without files.
 */
interface InitialRequestData {
  prompt: string;
  image: string;
  imageMimeType: string;
  llmName: string;
  maxTurns?: number;
  assumptions?: string;
  files?: { name: string, content: string }[]; // This will be populated by chunks
  apiKey?: string;
  saveFiles?: boolean; 
  mode?: ServerMode;
  projectSpecification?: string;
  environmentInstructions?: string;
  notWorkingBuild?: boolean;
  weaveId?: string;
  maxDurationMs?: number;
  gracePeriodMs?: number;
}

/**
 * Defines the structure for the data in a 'FILE_CHUNK' message.
 */
interface FileChunkData {
  files: { name: string, content: string }[];
}


// --- WebSocket Server Implementation ---

// Map to store connected clients, keyed by UUID
const clients: Map<string, WebSocket> = new Map();
// Maps to store orchestrator instances and their abort controllers
const orchestratorInstances: Map<string, Orchestrator> = new Map();
const abortControllers: Map<string, AbortController> = new Map();

// Map to store pending task data before all files are received
const pendingTasks: Map<string, InitialRequestData> = new Map();


/**
 * Initializes the WebSocket server.
 * @param {number} port - The port number to listen on.
 * @param {http.Server} [httpServer=null] - An optional existing HTTP server instance.
 */
function initializeWebSocketServer(port: number, httpServer: http.Server | null = null): void {
  const wss = httpServer ? new WebSocketServer({ server: httpServer }) : new WebSocketServer({ port });

  wss.on('error', (error: Error) => {
    console.error(`WebSocket server error: ${error.message}`);
  });

  wss.on('connection', (ws: WebSocket) => {
    const uuid = uuidv4();
    clients.set(uuid, ws);
    console.log(`Client connected with UUID: ${uuid}`);

    ws.on('message', (message: WebSocket.RawData) => {
      handleIncomingMessage(uuid, message);
    });

    // Handle client disconnection gracefully
    ws.on('close', () => {
      console.log(`Client disconnected with UUID: ${uuid}`);
      // Abort any running orchestrator task for this client
      const controller = abortControllers.get(uuid);
      if (controller) {
        controller.abort();
        console.log(`Aborted orchestrator task for client ${uuid}.`);
      }
      // Clean up all resources associated with the client
      clients.delete(uuid);
      orchestratorInstances.delete(uuid);
      abortControllers.delete(uuid);
      pendingTasks.delete(uuid);
    });

    ws.on('error', (error: Error) => {
      console.error(`WebSocket error for client ${uuid}: ${error.message}`);
      clients.delete(uuid);
      pendingTasks.delete(uuid);
    });
  });

  console.log(`WebSocket server started on port ${port}`);
}

/**
 * Sends a message to a specific client.
 * @param {string} clientUUID - The UUID of the client to send the message to.
 * @param {string} message - The message payload to send.
 */
function sendMessage(clientUUID: string, message: string): void {
  const ws = clients.get(clientUUID);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  } else {
    console.log(`Client ${clientUUID} not found or connection not open. Ready state: ${ws?.readyState}`);
  }
}

/**
 * Handles incoming messages from clients by parsing and routing them.
 * @param {string} clientUUID - The UUID of the client.
 * @param {WebSocket.RawData} message - The raw message received from the client.
 */
async function handleIncomingMessage(clientUUID: string, message: WebSocket.RawData): Promise<void> {
  try {
    const parsedMessage: WebSocketMessage = JSON.parse(message.toString());
    console.log(`Received message status ${parsedMessage.status} from client ${clientUUID}`);

    switch (parsedMessage.status) {
      case 'INITIAL_REQUEST_PARAMS':
        if (parsedMessage.data) {
          handleInitialRequestParams(clientUUID, parsedMessage.data);
        } else {
          console.error(`Error: 'data' property is missing for INITIAL_REQUEST_PARAMS from client ${clientUUID}`);
        }
        break;

      case 'FILE_CHUNK':
        if (parsedMessage.data) {
          handleFileChunk(clientUUID, parsedMessage.data);
        } else {
          console.error(`Error: 'data' property is missing for FILE_CHUNK from client ${clientUUID}`);
        }
        break;

      case 'START_TASK':
        handleStartTask(clientUUID);
        break;

      case 'HITL_RESPONSE':
        if (parsedMessage.answer !== undefined) {
          handleHitlResponse(clientUUID, parsedMessage.answer);
        } else {
          console.error(`Error: 'messageId' or 'answer' is missing for HITL_RESPONSE from client ${clientUUID}`);
        }
        break;
      default:
        console.log(`Unknown message type: ${parsedMessage.status}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing message from client ${clientUUID}: ${errorMessage}`);
  }
}

/**
 * Handles the initial request parameters (without files).
 * Stores the parameters and waits for file chunks.
 */
async function handleInitialRequestParams(clientUUID: string, requestData: InitialRequestData): Promise<void> {
  if (orchestratorInstances.has(clientUUID) || pendingTasks.has(clientUUID)) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'A task is already running or pending for this client.' }));
    return;
  }

  try {
    if (!requestData.prompt || !requestData.llmName) {
      sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: prompt or llmName is missing' }));
      return;
    }

    // Initialize the files array and store the pending task
    requestData.files = [];
    pendingTasks.set(clientUUID, requestData);

    // Send acknowledgment to client
    sendMessage(clientUUID, JSON.stringify({ status: 'PARAMS_RECEIVED', message: 'Parameters received. Ready for files.' }));
    console.log(`Parameters received for client ${clientUUID}. Waiting for files.`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error handling initial params from client ${clientUUID}:`, error);
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: `Parameter handling failed: ${errorMessage}\n` }));
  }
}

/**
 * Handles incoming file chunks and appends them to the pending task.
 */
async function handleFileChunk(clientUUID: string, chunkData: FileChunkData): Promise<void> {
  const task = pendingTasks.get(clientUUID);
  
  if (!task) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: No pending task found. Please send INITIAL_REQUEST_PARAMS first.' }));
    return;
  }

  if (!chunkData.files || !Array.isArray(chunkData.files)) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: Invalid file chunk format.' }));
    return;
  }

  // Append received files to the task's file list
  task.files = (task.files || []).concat(chunkData.files);
  console.log(`Received ${chunkData.files.length} files from client ${clientUUID}. Total files: ${task.files.length}`);

  // Send chunk acknowledgment
  sendMessage(clientUUID, JSON.stringify({ status: 'CHUNK_RECEIVED' }));
}

/**
 * Handles the signal to start the task after all files are uploaded.
 */
async function handleStartTask(clientUUID: string): Promise<void> {
  const taskData = pendingTasks.get(clientUUID);

  if (!taskData) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: No task data found to start.' }));
    return;
  }

  // Task data is complete. Remove it from pending and start the orchestrator.
  pendingTasks.delete(clientUUID);
  console.log(`All files received for client ${clientUUID}. Starting orchestrator...`);

  // Call the original handleInitialRequest function with the now-complete data
  await handleInitialRequest(clientUUID, taskData);
}


async function handleInitialRequest(clientUUID: string, requestData: InitialRequestData): Promise<void> {
  if (orchestratorInstances.has(clientUUID)) {
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'An orchestrator task is already running for this client.' }));
    return;
  }

  try {
    if (!requestData.prompt || !requestData.llmName) {
      sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: 'Error: prompt or llmName is missing' }));
      return;
    }

    const {
      prompt,
      image,
      imageMimeType,
      llmName,
      maxTurns,
      assumptions,
      files,
      saveFiles,
      mode,
      projectSpecification: requestProjectSpecification,
      environmentInstructions,
      notWorkingBuild,
      maxDurationMs,
      gracePeriodMs
    } = requestData;

    const projectSpecification = "";

    // 1. Create a new, request-specific Config instance
    const requestConfig = new Config({
      sessionId: randomUUID(),
      debugMode: false,
      model: llmName, 
      maxTurns: maxTurns ?? 20,
      assumptions: assumptions,
      embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
      cwd: process.cwd(),
      question: '',
      fullContext: false,
    });

    await requestConfig.refreshAuth(AuthType.USE_GEMINI);

    const geminiClient = await requestConfig.getGeminiClient();

    const controller = new AbortController();

    const ws = clients.get(clientUUID);
    const progressQueue = ws ? new ProgressQueue(ws, clientUUID) : null;

    const sendMessageCallback = (message: any) => {
      // Route tagged updates (Strings and Promises) to the queue
      if (typeof message === 'object' && message !== null && message.type === 'PROGRESS_UPDATE') {
        if (progressQueue) {
          progressQueue.add(message.message);
        }
      } 
      // Fallback for standard stringified JSON (e.g., updateLog, status updates)
      else if (typeof message === 'string') {
        sendMessage(clientUUID, message);
      }
    };

    const fileMap = new Map<string, string>();
    const binaryFileMap = new Map<string, string>();
    if (files) {
      files.forEach(file => {
        const fileBuffer = Buffer.from(file.content, 'base64');
        
        if (isBinaryFileSync(fileBuffer)) {
          // If binary, store the original base64 content
          binaryFileMap.set(file.name, file.content);
        } else {
          // If text, decode to a UTF-8 string
          fileMap.set(file.name, fileBuffer.toString('utf-8'));
        }
      });
    }

    const secrets: UserSecrets = {
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      julesApiKey: process.env.JULES_API_KEY || '',
      githubToken: process.env.GITHUB_TOKEN || '',
      stitchApiKey: process.env.STITCH_API_KEY || '',
      e2BApiKey: process.env.E2B_API_KEY || '',
      githubScratchPadRepo: process.env.GITHUB_SCRATCHPAD_REPO || '',
      gcpProjectId: process.env.GCP_PROJECT_ID || '',
      googleAccessToken: process.env.GOOLGE_ACCESS_TOKEN || '',
      cloudWorkstationName: process.env.CLOUD_WORKSTATION_NAME || '',
      sshTunnelUrl: process.env.SSH_TUNNEL_URL || "",
      remoteDesktopKey: process.env.REMOTE_DESKTOP_AGENT_KEY || '',
    };

    const orchestrator = new Orchestrator(
      prompt,
      image,
      imageMimeType,
      fileMap,
      binaryFileMap,
      geminiClient,
      sendMessageCallback,
      assumptions ?? '',
      llmName,
      saveFiles ?? false,
      secrets,
      requestConfig,
      'Untitled Session',
      projectSpecification,
      environmentInstructions,
      notWorkingBuild,
      controller.signal,
      mode,
      maxDurationMs,
      gracePeriodMs
    );

    orchestratorInstances.set(clientUUID, orchestrator);
    abortControllers.set(clientUUID, controller);

    console.log(`LOGGING: Invoking orchestrator for client ${clientUUID} using model ${llmName}`);
    sendMessage(clientUUID, JSON.stringify({ status: 'WORK_LOG', message: `# Orchestrator invoked successfully:\n${prompt}\n\n` }));

    // 3. Run the orchestrator asynchronously
    orchestrator.run()
      .catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Orchestrator for client ${clientUUID} failed:`, error);
        sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: `Orchestrator failed: ${errorMessage}\n` }));
      })
      .finally(() => {
        console.log(`Orchestrator task finished for client ${clientUUID}. Cleaning up.`);
        orchestratorInstances.delete(clientUUID);
        abortControllers.delete(clientUUID);
      });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error handling initial request from client ${clientUUID}:`, error);
    sendMessage(clientUUID, JSON.stringify({ status: 'ERROR', message: `Orchestrator/Analyzer invocation failed: ${errorMessage}\n` }));
  }
}

/**
 * @param {string} clientUUID - The UUID of the client.
 * @param {any} answer - The response data from the user.
 */
async function handleHitlResponse(clientUUID: string, answer: any): Promise<void> {
  const orchestrator = orchestratorInstances.get(clientUUID);

  if (orchestrator) {
    // The orchestrator's internal resolver handles the response.
    orchestrator.resolveHitl(answer);
  } else {
    console.error(`No active orchestrator found for client ${clientUUID} to handle HITL response.`);
  }
}

// Export the public functions
export {
  initializeWebSocketServer,
  handleIncomingMessage,
  handleInitialRequestParams,
  handleFileChunk,
  handleStartTask,
  handleInitialRequest,
  handleHitlResponse,
  sendMessage
};