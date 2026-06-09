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

import { GeminiClient } from '../services/geminiClient.js';
import { TranscriptManager } from '../services/transcriptManager.js';
import { UserSecrets } from '../shared/model.js';
import { Overseer } from './overseer.js';

export interface FileContent {
  path: string;
  content: string;
}

export interface MarkerPair {
  begin: string;
  end: string;
}

export interface Expert {
  name: string;
  transcript: TranscriptManager;
  model?: string | undefined;
  inRoomTemperature?: number | undefined ;
}

export interface FileSummary {
  filename: string,
  description?: string | undefined,
  detailedSummary?: string | undefined,
  relatedFiles?: string | undefined
}

export interface FAQ {
  question: string,
  answer: string,
  created: Date
}

export enum GuidanceType {
  StandardOverseerGuidance = 'OVERSEER_GUIDANCE',
  ForcedUserGuidance = 'FORCED_USER_GUIDANCE'
}

export interface OverseerFeedback {
  action: string;
  reasoning: string;
  guidance?: string;
  type: GuidanceType;
}

export enum VerbosityType {
  Verbose = 'VERBOSE',
  AISummarize = 'AI_SUMMARIZE',
  Quiet = 'QUIET'
}

export enum ToolExecutionEnvironmentType {
  Local = "LOCAL",
  CloudRun = "CLOUDRUN",
  CloudShellEditor = "CLOUDSHELLEDITOR",
  CloudWorkstation = "CLOUDWORKSTATION",
  E2B = "E2B",
  Inverse_SSH_Tunnel = "INVERSE_SSH_TUNNEL",
  Remote_Desktop_Agent = "REMOTE_DESKTOP_AGENT"
}

export interface MultiAgentToolContext {
  initialPrompt: string;
  initialImage?: string;
  initialImageMimeType?: string;
  fileMap: Map<string, string>;
  binaryFileMap: Map<string, string>;
  editedFilesSet: Set<string>;
  originalFilesSet: Set<string>;
  originalFileMap: Map<string, string>;
  originalBinaryFileMap: Map<string, string>;
  sendMessage: (message: any) => void;
  multiAgentGeminiClient: GeminiClient;
  experts: string[];
  transcriptsToUpdate: TranscriptManager[];
  transcriptForContext: TranscriptManager;
  overseer: Overseer | undefined;
  saveFileResolver: ((outcome: ToolConfirmationOutcome) => void) | null;
  infrastructureContext: InfrastructureContext;
  saveFiles: boolean;
  julesSessionSummaries?: string[];
  julesBranchName?: string | null;
  julesSessionName?: string | undefined;
  assumptions?: string;
  secrets: UserSecrets;
  projectSpecification?: string;
  environmentInstructions?: string;
  notWorkingBuild?: boolean;
  signal?: AbortSignal;
  projectDeadlineMs?: number;
  gracePeriodMs?: number;
  toolExecutionEnvironment: string;
  sessionTitle: string;
}

export interface FuzzyReplaceResult {
  error?: string, 
  modifiedString?: string, 
  multipleMatches?: string[]
}

export enum FileOperation {
  Edit = 'Edit',
  Delete = 'Delete',
  Create = 'Create',
  Move = 'Move'
}

export enum ToolConfirmationOutcome {
  ProceedOnce = 'proceed_once',
  ProceedAlways = 'proceed_always',
  ProceedAlwaysServer = 'proceed_always_server',
  ProceedAlwaysTool = 'proceed_always_tool',
  ModifyWithEditor = 'modify_with_editor',
  Cancel = 'cancel',
  CancelAndRevert = 'cancel_and_revert',
}

export interface MultiAgentToolResult {
  result: string,
  transcriptReplacementID?: string,
  transcriptReplacementString?: string
}

interface SuccessfulToolParsing {
  success: true;
  params: Record<string, unknown | string[]>;
}

interface FailedToolParsing {
  success: false;
  error: string;
}

export interface AssetPurpose {
  id: string;
  purpose: string;
}

export type ToolParsingResult = SuccessfulToolParsing | FailedToolParsing;

export const USER_ROLE = 'user';
export const MODEL_ROLE = 'model';

export interface FormattedTranscriptPart {
  text?: string;
  inlineData?: { mimeType: string; data: string; };
  functionCall?: FunctionCall;
  functionResponse?: ToolResult;
}

export interface FormattedTranscriptEntry {
  role: string;
  parts: FormattedTranscriptPart[];
  ephemeral?: boolean;
}

export interface ToolProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  items?: {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'object';
  };
  properties?: Record<string, ToolProperty>;
  required?: string[];
}

export interface ToolFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required: string[];
  };
}

export interface FunctionCall {
  name: string;
  args: Record<string, string | string[]>;
}

export interface ToolResult {
  role: string;
  name: string;
  response: string;
  filename?: string;
}

export interface ModifySpecResult {
  full_content: string;
  reason: string;
}

export interface ProjectAnalysisResult {
  title: string;
  description: string;
  spec: string;
}

// Tool names required for the client-side ReAct implementation
export const READ_FILES_TOOL_NAME = 'read_file';
export const MODIFY_SPEC_TOOL_NAME = 'modify_spec';

export interface InfrastructureContext {
  getToolNames(): string[];
  getToolResultPrefix(): Promise<string>;
  getToolResultSuffix(): Promise<string>;
  getAssetString(name: string): Promise<string>;
  getSessionId(): string;
}

export interface GeminiClientConfig {
  apiKey: string;
  context: InfrastructureContext;
}

export interface TranscriptManagerConfig {
  context: InfrastructureContext;
}

export interface ScreenPreviewURLs {
  htmlCode?: { downloadUrl?: string };
  screenshot?: { downloadUrl?: string };
}

export interface DesignResponseItem {
  designSystem?: {
    designSystem?: {
      theme?: {
        designMd?: string;
      };
    };
  };
  design?: {
    screens?: ScreenPreviewURLs[];
  };
  text?: string;
  suggestion?: string;
}

export interface ExtractedData {
  htmlUrls: string[];
  previewUrls: string[];
  combinedText: string;
  designMarkdown: string;
  hasPreviewUrls: boolean;
}

export const LARGE_FILE_LIMIT_KB = 100;
export const MAX_CONTEXT_FILE_SIZE_BYTES = 100 * 1024 * 1024;