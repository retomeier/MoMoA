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

import { logFilename } from "../../config/config";
import { MultiAgentToolContext, MultiAgentToolResult, ToolParsingResult } from "../../momoa_core/types";
import { MultiAgentTool } from "../multiAgentTool";

/**
 * Tool to append entries to the RESEARCH_LOG.md.
 * Ensures the log remains append-only and includes a timestamp.
 */
export const researchLogTool: MultiAgentTool = {
  displayName: "Research Logger",
  name: 'UPDATE_RESEARCH_LOG',

  async execute(params: Record<string, string>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    
    const entry = params.entry;

    if (!entry) {
      return { result: "Error: No log entry provided." };
    }

    let trimmed = entry.trim();

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        // Slice from index 1 to the second-to-last character
        trimmed = trimmed.slice(1, -1).trim();
    }

    // Get current time/date in a readable format
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
    const formattedEntry = `## [${timestamp} UTC]\n${trimmed}\n\n----\n\n`;

    // Retrieve existing content or start fresh
    const existingContent = context.fileMap.get(logFilename) ?? "";
    const updatedContent = (formattedEntry + existingContent).trim();

    // Update the in-memory file map
    context.fileMap.set(logFilename, updatedContent);
    context.editedFilesSet.add(logFilename);

    // Sync to disk if saveFiles is enabled
    if (context.saveFiles) {
      context.sendMessage(JSON.stringify({
        status: 'APPLY_FILE_CHANGE',
        data: {
          filename: logFilename,
          content: Buffer.from(updatedContent).toString('base64'),
        }
      }));
    }

    const successMsg = `Appended Research Log entry to \`${logFilename}\`\n\`\`\`\`\n${trimmed}\n\`\`\`\``;
    
    // Log to the work log for visibility
    context.sendMessage(JSON.stringify({
      status: 'WORK_LOG',
      message: successMsg,
    }));

    context.sendMessage(JSON.stringify({
        status: "PROGRESS_UPDATES",
        completed_status_message: successMsg,
      })
    );

    return { result: successMsg };
  },

  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    const entry = invocation.trim();
    if (entry) {
      return { success: true, params: { entry } };
    }
    return { success: false, error: "Log entry cannot be empty." };
  }
};