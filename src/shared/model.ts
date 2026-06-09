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


/**
 * Defines the structure for incoming messages.
 */
export type IncomingAction = {
  status:
    | "INITIAL_REQUEST_PARAMS"
    | "FILE_CHUNK"
    | "START_TASK"
    | "HITL_RESPONSE"
    | "ABORT"
    | (string & {});
  data?: any; // Use 'any' for data to accommodate different payload structures
  messageId?: string;
  answer?: any;
};

export enum ServerMode {
   ORCHESTRATOR = 'orchestrator',
};

/**
 * Defines the structure for the data in an 'INITIAL_REQUEST_PARAMS' message,
 * matching the Python client's payload but without files.
 */
export interface InitialRequestData {
  prompt: string;
  image?: string; // Optional Base64 encoded image data
  imageMimeType?: string; // Optional MIME type of the attached image
  llmName: string;
  githubUrl?: string;
  maxTurns?: number;
  assumptions?: string; 
  files?: { name: string; content: string }[]; // This will be populated by chunks
  saveFiles?: boolean;
  secrets: UserSecrets;
  mode?: ServerMode;
  projectId?: string;
  projectSpecification?: string;
  environmentInstructions?: string;
  notWorkingBuild?: boolean;
  weaveId?: string;
  maxDurationMs?: number;
  gracePeriodMs?: number;
  toolExecutionEnvironment?: string;
}

export interface UserSecrets {
  geminiApiKey: string;
  julesApiKey: string;
  githubToken: string;
  stitchApiKey: string;
  e2BApiKey: string;
  githubScratchPadRepo: string;
  gcpProjectId: string;
  googleAccessToken: string;
  cloudWorkstationName: string;
  sshTunnelUrl: string;
  remoteDesktopKey: string;
}

/**
 * Defines the structure for the data in a 'FILE_CHUNK' message.
 */
export interface FileChunkData {
  files: { name: string; content: string }[];
}

export interface ProjectMetadata {
  title: string;
  description: string;
  ownerId: string;
  repoPath?: string;
  githubUrl?: string;
}

export interface OutgoingMessage {
  status:
    | "USER_MESSAGE"
    | "WORK_LOG"
    | "ERROR"
    | "PROGRESS_UPDATES"
    | 'HITL_QUESTION'
    | "COMPLETE_RESULT"
    | (string & {});
  message?: string;
  completed_status_message?: string;
  current_status_message?: string;
  data?: {
    feedback?: string;
    files?: string;
    result?: string;
    retrospective?: string;
  };
}

export interface HistoryItem extends OutgoingMessage {
  timestamp: number;
  runnerInstanceId: string;
}