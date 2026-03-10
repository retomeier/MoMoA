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

import { MultiAgentTool } from './multiAgentTool.js';
import { fileReaderTool } from './implementations/fileReaderTool.js';
import { smartFileEditorTool } from './implementations/smartFileEditorTool.js';
import { askExpertTool } from './implementations/askExpertTool.js';
import { fileSearchTool } from './implementations/fileSearchTool.js';
import { paradoxResolutionTool } from './implementations/paradoxResolutionTool.js';
import { moveFolderTool } from './implementations/renameFolderTool.js';
import { MultiAgentToolContext, MultiAgentToolResult } from '../momoa_core/types.js';
import { getAssetString } from '../services/promptManager.js';
import { regexValidatorTool } from './implementations/regexValidatorTool.js';
import { restartProjectTool } from './implementations/projectRestartTool.js';
import { revertFileTool } from './implementations/revertFileTool.js';
import { urlFetchTool } from './implementations/urlFetchTool.js';
import { LintTool } from './implementations/LintTool.js';
import { factFinderTool } from './implementations/FactFinderTool.js';
import { OptimizerTool } from './implementations/optimizerTool.js';
import { CodeRunnerTool } from './implementations/codeRunnerTool.js';
import { researchLogTool } from './implementations/researchLogTool.js';

// The state is a module-level constant, making it private to this module.
const tools = new Map<string, MultiAgentTool>();

/**
 * Registers a tool with the registry. This function is not exported,
 * so it's private to the module.
 * @param tool The tool instance to register.
 */
function registerTool(tool: MultiAgentTool): void {
  if (tools.has(tool.name)) {
    console.warn(`Tool "${tool.name}" is already registered. Overwriting.`);
  }
  tools.set(tool.name, tool);
}

/**
 * Returns an array of the names of all registered tools.
 * @returns {string[]} An array of tool names.
 */
export function getToolNames(): string[] {
  return [...tools.keys()];
}

/**
 * Retrieves a tool by its name.
 * @param {string} toolName The name of the tool to retrieve.
 * @returns {Tool | undefined} The tool instance or undefined if not found.
 */
export function getTool(toolName: string): MultiAgentTool | undefined {
  return tools.get(toolName);
}

/**
 * Executes a registered tool by its name with the given parameters and context.
 * If the tool is not registered, it returns an error message.
 *
 * @param toolName The name of the tool to execute.
 * @param params The parameters for the tool's execution.
 * @param context The ToolContext object containing necessary runtime information.
 * @returns A promise that resolves to the tool's output string or an error message.
 */
export async function executeTool(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
  context: MultiAgentToolContext
): Promise<MultiAgentToolResult> {
  const toolResultPrefix = await getAssetString('tool-result-prefix');
  const toolResultSuffix = await getAssetString('tool-result-suffix');

  if (!toolName) {
    return {result: 'No valid tool name was provided.'};
  }

  const tool = tools.get(toolName);

  if (!tool) {
    return {result: `Error: Tool '${toolName}' is not implemented yet.`};
  }

  if (!params) {
    return {result: `No valid parameters were found for ${tool?.displayName}.`};
  }

  try {
    const toolResult = await tool.execute(params, context);
    return {
      result: `${toolResultPrefix}\n${toolResult.result}\n${toolResultSuffix}`,
      transcriptReplacementID: toolResult.transcriptReplacementID,
      transcriptReplacementString: `${toolResultPrefix}\n${toolResult.transcriptReplacementString}\n${toolResultSuffix}`
    }
  } catch (error: unknown) {
    let errorMessage: string;
    if (error instanceof Error) {
      errorMessage = `Error executing ${tool?.displayName} tool: ${error.message}`;
    } else {
      errorMessage = `Error executing ${tool?.displayName} tool.`;
    }
    return {
      result: `${toolResultPrefix}\n${errorMessage}\n${toolResultSuffix}`,
    }
  }
}

// --- Module Initialization ---
registerTool(fileReaderTool);
registerTool(smartFileEditorTool);
registerTool(askExpertTool);
registerTool(fileSearchTool);
registerTool(paradoxResolutionTool);
registerTool(moveFolderTool);
registerTool(regexValidatorTool);
registerTool(restartProjectTool);
registerTool(revertFileTool);
registerTool(urlFetchTool);
registerTool(LintTool);
registerTool(factFinderTool);
registerTool(OptimizerTool);
registerTool(CodeRunnerTool);
registerTool(researchLogTool);
// Future tools will be registered here.