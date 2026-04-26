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

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { MultiAgentTool } from '../multiAgentTool.js';
import { MultiAgentToolResult, MultiAgentToolContext, ToolParsingResult } from '../../momoa_core/types.js';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { isLockFile } from '../../utils/diffGenerator.js';
import { fileNameLookup } from '../../utils/fileNameLookup.js';
import { getCombinedFileMap } from '../../utils/fileMapUtils.js';

// --- Utility Functions ---

/**
 * Determines the temporary full file path where the file content will be saved.
 * We use a simple structure relative to the current working directory.
 * @param sessionId A unique identifier for the current session (e.g., clientUUID).
 * @param filename The name of the file.
 * @returns The full path to the temporary file.
 */
function getFullFilePath(sessionId: string, filename: string): string {
    // Correctly uses the system temp directory (usually /tmp in Cloud Run)
    const systemTempDir = tmpdir();
    
    // Structure: /tmp/momoa_lint/<sessionId>/<filename>
    // Adding 'momoa_lint' namespace prevents collisions with other tools using /tmp
    const tempDir = path.join(systemTempDir, 'momoa_lint', sessionId);
    return path.join(tempDir, filename);
}

/**
 * Saves the file content to the temporary location.
 * @param sessionId Unique session identifier.
 * @param filename The name of the file.
 * @param fileContent The content to save.
 */
async function saveFile(sessionId: string, filename: string, fileContent: string): Promise<void> {
    const fullPath = getFullFilePath(sessionId, filename);
    const dirPath = path.dirname(fullPath);

    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(fullPath, fileContent, 'utf8');
    console.log(`File saved successfully to ${fullPath}`);
}

/**
 * Detects the programming language based on the file extension.
 *
 * @param filename - The name of the file.
 * @returns A string indicating the detected language ('python', 'javascript', 'go', 'java', 'cpp', 'kotlin', 'docker', 'maven'), or 'unknown'.
 */
function detectLanguage(filename: string): string {
    // One off file names
    const baseName = path.basename(filename).toLowerCase();
    if (baseName === 'pom.xml')
        return 'maven';
    else if (baseName === 'dockerfile')
        return 'docker';

    // Find the last dot in the filename to extract the extension.
    const lastDotIndex = filename.lastIndexOf('.');

    // If no dot or the dot is the first character (e.g., '.bashrc'), there's no standard extension.
    if (lastDotIndex < 1) {
        return 'unknown';
    }

    // Extract the extension including the dot and convert to lowercase for case-insensitive matching.
    const extension = filename.substring(lastDotIndex).toLowerCase();

    // Files based on extensions
    switch (extension) {
        case '.py':
            return 'python';
        case '.tsx':
        case '.ts':
        case '.js':
            return 'javascript';
        case '.go':
            return 'go';
        case '.java':
            return 'java';
        case '.kt':
            return 'kotlin';
        case '.cpp':
        case '.cxx':
        case '.cc':
        case '.h':
        case '.hpp':
            return 'cpp';
        default:
            return 'unknown';
    }
}

/**
 * Executes an external command using child_process.spawn.
 *
 * @param command The command to execute.
 * @param args Arguments for the command.
 * @param filename The original filename (for output formatting).
 * @param fullFileName The full path to the temporary file.
 * @param resultPrefixString Prefix for the output string.
 * @param successString String to return on successful execution with no output.
 * @returns A promise that resolves with the formatted output string.
 */
function processExecution(command: string, args: string[], filename: string, fullFileName: string, resultPrefixString: string, successString: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        // Use 'spawn' for security to prevent command injection by keeping
        // command and arguments separate.
        console.log("Execute: " + command + " " + args.join(' '));

        const cmdLineProcess = spawn(command, args, { 
          shell: false, 
          cwd: cwd, 
          env: env || process.env
        });

        // Implement timeout
        const timeout = setTimeout(() => {
            cmdLineProcess.kill('SIGTERM');
            reject(`${resultPrefixString}Error: Process timed out after 60 seconds.`);
        }, 60000); // 60 seconds timeout

        cmdLineProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        cmdLineProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        cmdLineProcess.on('error', (err) => {
            // Handle errors like command not found
            clearTimeout(timeout);
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(`${resultPrefixString}Error: Command "${command}" not found. Please ensure it is installed and in the system's PATH.`);
            } else {
                reject(`${resultPrefixString}Error spawning process: ${err.message}`);
            }
            console.error("Process Spawn Error");
        });

        cmdLineProcess.on('close', (_code) => {
            clearTimeout(timeout);
            let combinedOutput = stdout + stderr;

            if (!combinedOutput) {
                combinedOutput = successString;
            }
            const resultPrefix = resultPrefixString;

            // We'll generally need to remove the path strings to avoid confusion.
            const completePath = path.resolve(fullFileName);
            combinedOutput = combinedOutput.replaceAll(completePath, filename);
            combinedOutput = combinedOutput.replaceAll(fullFileName, filename);

            // Always return whatever came from the linter.
            resolve(`${resultPrefix}\n${combinedOutput}`);
        });
    });
}

// --- LintTool Class ---
export const LintTool: MultiAgentTool = {
  displayName: "Lint Tool",
  name: 'LINT{',
  endToken: '}',

  /**
   * Executes the linting process for a given file.
   * @param params Must contain 'filename'.
   * @param context The tool context.
   * @returns The linter output.
   */
  async execute(params: Record<string, unknown>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    const providedFilename = params['filename'] as string;

    if (!providedFilename) {
      return {
        result: `Error: 'filename' parameter is missing for ${this.displayName} tool.`
      };
    }

    // Combine keys from both maps for a comprehensive lookup.
    const allFilesMap = getCombinedFileMap(context.fileMap, context.binaryFileMap);

    let filename = providedFilename.trim();
    
    if (!allFilesMap.has(filename)) {
        // File not found. NOW, let's try to find a suggestion.
        const suggestion = await fileNameLookup(filename, allFilesMap, context.multiAgentGeminiClient);

        if (suggestion && suggestion !== filename && allFilesMap.has(suggestion)) {
            return {
                result: `File '${filename}' was not found. Did you mean '${suggestion}'?`
            };
        }

        return {
          result: `---File '${filename}' not found---`
        };
    }

    context.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: `Linting \`${filename}\``,
      }
    );

    // Handle binary files first.
    if (context.binaryFileMap.has(filename)) {
       return { result: "Binary files are not supported for linting." }
    }

    // Handle Lock Files
    if (isLockFile(filename)) {
       return { result: "Lock files are not supported for linting." }
    }

    const fileContent = context.fileMap.get(filename);
    if (!fileContent) {
       return { result: `\`${filename}\` is empty.` }
    }

    // Use a unique identifier for the session to scope temporary files.
    // We use the transcript ID if available, otherwise a fixed string.
    const sessionId = context.infrastructureContext.getSessionId() || randomUUID.toString();
    const fullFileName = getFullFilePath(sessionId, filename);

    try {
      // 1. Save the file to disk.
      await saveFile(sessionId, filename, fileContent);
      const language = detectLanguage(filename);

      // If C++, identify and copy sibling header files to the temp directory.
      if (language === 'cpp') {
          const targetDir = path.dirname(filename);
          
          // Iterate over all available files in the context
          for (const [candidateName, candidateContent] of context.fileMap.entries()) {
              // skip the file we just saved
              if (candidateName === filename) continue;

              // Check if it is a sibling (same directory) and a header file
              if (path.dirname(candidateName) === targetDir) {
                  const ext = path.extname(candidateName).toLowerCase();
                  if (ext === '.h' || ext === '.hpp') {
                      // Save the header file to the same relative path in the temp dir
                      await saveFile(sessionId, candidateName, candidateContent);
                  }
              }
          }
      }

      let linterCommand: string | null = null;
      let linterArgs: string[] = [];

      switch (language) {
        case 'python':
          linterCommand = 'python3'; 
          linterArgs = ['-m', 'flake8', fullFileName, '--config', 'linter-tool-definition-files/.flake8', '--show-source'];
        break;        
        case 'javascript':
          // 1. Point to Hub's Binary (Absolute Path)
          linterCommand = path.resolve('node_modules', '.bin', 'eslint');
          
          // 2. Point to Hub's Config (Absolute Path)
          const configPath = path.resolve('linter-tool-definition-files', 'eslint.config.js');
          
          // 3. Target the file by BASENAME (since we will be inside the temp dir)
          linterArgs = [
              path.basename(fullFileName), 
              '--config', configPath, 
              '--no-color', 
              '--format', 'codeframe' 
          ];
          break;
        case 'go':
          linterCommand = 'revive';
          // -formatter friendly: output format that is easy to parse
          // fullFileName: the file to lint
          linterArgs = ['-formatter', 'friendly', fullFileName];
          break;
        case 'java':
          linterCommand = 'java';
          // Note: This assumes checkstyle-10.23.1-all.jar is a valid JAR file.
          linterArgs = ['-jar', 'linter-tool-definition-files/checkstyle-10.23.1-all.jar', fullFileName, '-c', 'linter-tool-definition-files/google_checks.xml'];
          break;
        case 'cpp':
          linterCommand = 'clang-tidy';
          // Add standard flags for C++, ensure filename is first arg
          linterArgs = [
            fullFileName, 
            '-checks=-clang-diagnostic-error', 
            '--', 
            '-std=c++17', 
            '-Iinclude', 
            '-DNDEBUG'
          ];
          break;
        case 'docker':
          linterCommand = 'hadolint'; // Refactored to use globally installed binary
          linterArgs = [fullFileName];
          break;
        case 'kotlin':
          linterCommand = 'ktlint'; 
          linterArgs = [
              '--editorconfig=linter-tool-definition-files/.editorconfig',
              fullFileName
          ];
          break;
        case 'maven':
          linterCommand = 'mvn';
          linterArgs = ['validate', '-f', fullFileName, '-B', '-q', '-U'];
          break;
        default:
          return { result: `You asked to lint ${filename} and this is the result from the Lint tool:\nUnsupported language or unknown file extension for ${filename}.` };
      }

      if (!linterCommand) {
        return { result: `You asked to lint ${filename} and this is the result from the Linter:\nInternal error: Could not determine linter command for language ${language}.` };
      }

      // Determine working directory: 
      // For JavaScript, we MUST run inside the temp dir to avoid "outside of base path" errors.
      // For others, we can stay in the Hub (process.cwd()).
      let executionCwd: string | undefined;
      let executionEnv: NodeJS.ProcessEnv = process.env;

      if (language === 'javascript') {
          executionCwd = path.dirname(fullFileName);

          const projectNodeModules = path.resolve(process.cwd(), 'node_modules');
          
          executionEnv = {
              ...process.env, // Inherit existing variables
              NODE_PATH: projectNodeModules // Add our fix
          };
      }

      const noWarningsOrErrors = "No warnings or errors were found.";
      const resultPrefix = `You asked to lint ${filename} and this is the result from the Linter:`;
      // Execute the linter command
      let output = await processExecution(
        linterCommand,
        linterArgs,
        filename,
        fullFileName,
        resultPrefix,
        noWarningsOrErrors,
        executionCwd, // Pass the new CWD
        executionEnv
      );

      // We use a Regex to match the dynamic parts:
      // 1. \(node:\d+\) matches "(node:30)", "(node:31)", etc.
      // 2. [\s\S]*? matches all the content (lines and text) in between non-greedily.
      // 3. The end text matches the specific footer of that Node warning.
      const warningRegex = /\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\][\s\S]*?\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\s*/;

      // Replace the regex match with an empty string
      output = output.replace(warningRegex, "").trim();

      // Check if the output is empty (or just the prefix)
      if (output === resultPrefix || output === "") {
          // Ensure we handle cases where resultPrefix might not be present if output was entirely the warning
          output = resultPrefix ? `${resultPrefix}\n${noWarningsOrErrors}` : noWarningsOrErrors;
      }

      context.sendMessage({
        type: 'PROGRESS_UPDATE',
        message: output,
      });

      return { result: output };

    } catch (error) {
      console.error(`LintTool execution failed for ${filename}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { result: `You asked to lint ${filename} and this is the result from the Linter:\nError during execution: ${errorMessage}` };    
    } finally {
        // --- Cleanup Logic ---
        try {
            // We should ideally remove all files we created, but removing the sessionDir
            // recursively handles everything inside it.
            const sessionDir = path.dirname(fullFileName);
            
            await fs.rm(sessionDir, { recursive: true, force: true });

            const namespaceDir = path.dirname(sessionDir); 
            await fs.rmdir(namespaceDir).catch(() => {});
        } catch (cleanupError) {
            // Ignore errors during cleanup (e.g. file already gone, dir not empty)
        }
    }
  },

  /**
   * Extract parameters from the tool invocation string.
   * @param invocation The string used to invoke the tool.
   * @returns The parameter names and corresponding values.
   */
  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    if (invocation.trim().endsWith("}")) {
      const filename = invocation.trim().slice(0, -1).trim();
      return {
        success: true, 
        params: {
          filename
        }
      };
    } else {
      return {
        success: false, 
        error: `Invalid syntax for the ${this.displayName} Tool. Make sure you include the curly brackets.`
      }
    }
  }
}