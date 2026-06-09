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

import { LocalExecutionProvider } from './executionProviders/localExecutionProvider.js';
import { CloudRunJobProvider } from './executionProviders/cloudRunJobExecutionProvider.js';
import { CloudShellExecutionProvider } from './executionProviders/cloudShellExecutionProvider.js';
import { MultiAgentToolContext, ToolExecutionEnvironmentType } from '../momoa_core/types.js';
import { E2BExecutionProvider } from './executionProviders/e2BExecutionProvider.js';
import { CloudWorkstationsExecutionProvider } from './executionProviders/cloudWorkstationsExecutionProvider.js';
import { SshExecutionProvider } from './executionProviders/sshExecutionProvider.js';
import { CLOUD_RUN_CONFIG } from '../cloudrun-config.js';

export const LARGE_FILE_LIMIT_KB = 100;
export const MAX_CONTEXT_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export interface ExecutionHandle {
  executionId: string;
  checkProgress: () => Promise<ExecutionResponse[]>;
  isDone: () => Promise<boolean>;
}

export interface FilePayload {
  path: string;
  content: string; // Base64 encoded for safe transport
  isBinary: boolean;
}

export interface ProcessHandle {
  writeStdin: (data: string) => Promise<void>;
  kill: () => Promise<void>;
}

export interface ExecutionRequest {
  command: string;
  cwd?: string;
  args?: string[];
  files?: FilePayload[];
  envs?: NodeJS.ProcessEnv[]; 
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onProcessCreated?: (handle: ProcessHandle) => void;
  onTaskComplete?: (result: ExecutionResponse) => void;
  estimatedTaskDurationMs?: number;
  estimatedTaskPeakMemory?: number;
  chunkSize?: number;
}

export interface ExecutionResponse {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  generatedFiles: FilePayload[];
  error?: string;
  durationMs?: number;
  peakMemory?: number;
  index?: number;
}

export interface ExecutionProvider {
  providerName: string;
  isPersistentSandbox: boolean;
  stageFiles(files: FilePayload[], targetDir: string): Promise<void>;
  execute(request: ExecutionRequest): Promise<ExecutionResponse>;
  cleanupSandbox(): Promise<void>;
}

export function getExecutionProvider(context: MultiAgentToolContext | undefined): ExecutionProvider | undefined {
  if (!context)
    return new LocalExecutionProvider();

  switch (context.toolExecutionEnvironment) {
    case ToolExecutionEnvironmentType.CloudWorkstation:
      return new CloudWorkstationsExecutionProvider(
        context.secrets.googleAccessToken,
        context.secrets.gcpProjectId,
        context.secrets.cloudWorkstationName);

    case ToolExecutionEnvironmentType.E2B: 
      if (!context.secrets.e2BApiKey)
        return undefined;
      return new E2BExecutionProvider(context.secrets.e2BApiKey);

    case ToolExecutionEnvironmentType.CloudRun:
      return new CloudRunJobProvider(
          CLOUD_RUN_CONFIG.projectId,
          CLOUD_RUN_CONFIG.location,
          CLOUD_RUN_CONFIG.jobname,
          CLOUD_RUN_CONFIG.storageBucket);

    case (ToolExecutionEnvironmentType.CloudShellEditor): 
      return new CloudShellExecutionProvider(
        context.secrets.gcpProjectId, 
        context.secrets.googleAccessToken);
    
    case (ToolExecutionEnvironmentType.Inverse_SSH_Tunnel):
      if (!context.secrets.sshTunnelUrl)
        return undefined;

      const sshConfig = parseTunnelUrl(context.secrets.sshTunnelUrl);
      return new SshExecutionProvider(
        sshConfig.host, 
        sshConfig.port, 
        "root", 
        "./sandbox_key");

    case (ToolExecutionEnvironmentType.Local): 
    default: 
      return new LocalExecutionProvider();
  }
}

function parseTunnelUrl(tunnelUrl: string): { host: string, port: number } {
    // 1. Clean up user input (remove spaces, trailing slashes)
    const cleanUrl = tunnelUrl.trim().replace(/\/+$/, '');

    // 2. Ensure it has a protocol so the URL parser doesn't treat it as a relative path
    const urlToParse = cleanUrl.includes('://') ? cleanUrl : `tcp://${cleanUrl}`;

    try {
        const parsed = new URL(urlToParse);
        
        const host = parsed.hostname;
        
        // ngrok will always have a port. Cloudflare usually won't, so we default to 22.
        const port = parsed.port ? parseInt(parsed.port, 10) : 22;

        if (!host) {
            throw new Error("Could not extract a valid hostname.");
        }

        return { host, port };
    } catch (error: any) {
        throw new Error(`Failed to parse tunnel URL "${tunnelUrl}": ${error.message}`);
    }
}