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
import * as os from 'os';
import { spawn } from 'child_process';
import { MultiAgentTool } from '../multiAgentTool.js';
import { MultiAgentToolResult, MultiAgentToolContext, ToolParsingResult } from '../../momoa_core/types.js';
import { addDynamicallyRelevantFile, updateFileEntry } from '../../utils/fileAnalysis.js';
import { logFilename, MAX_MEM_PERCENTAGE, MAX_SCRIPT_EXECUTION_TIMEOUT } from '../../config/config.js';

const LARGE_FILE_LIMIT_KB = 100;
const MAX_CONTEXT_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const PYTHON_REQUIRED_DEPS: string[] = [];//["numpy"]; 
const INSTALL_TIMEOUT_MS = 300000; // 5 minutes for installation
const EXECUTION_TIMEOUT_MS = MAX_SCRIPT_EXECUTION_TIMEOUT; // 10 minutes for script execution
const DEPS_DIR_NAME = '_momoa_deps'; // Directory to isolate dependencies

// Helper: Run script using spawn to avoid maxBuffer issues
const runScript = (
    cmd: string, 
    args: string[], 
    cwd: string, 
    env: NodeJS.ProcessEnv, 
    timeoutMs: number
) => {
    return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env });
        
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        
        // Cap collection to ~50MB to prevent memory exhaustion
        const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024; 

        const appendLog = (currentLog: string, newData: string) => {
            const combined = currentLog + newData;
            if (combined.length > MAX_LOG_SIZE) {
                return `[---Output Truncated Due to Length---]\n${combined.slice(-MAX_LOG_SIZE)}`;
            }
            return combined;
        };

        child.stdout.on('data', (data) => {
            stdout = appendLog(stdout, data.toString());
        });

        child.stderr.on('data', (data) => {
            stderr = appendLog(stderr, data.toString());
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM'); // Polite request
            
            // If the script is stubborn and hasn't closed after 2 seconds, drop the hammer.
            setTimeout(() => {
                if (!child.killed) {
                    try { child.kill('SIGKILL'); } catch (e) {}
                }
            }, 2000);
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, timedOut, exitCode: code });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
};

export const CodeRunnerTool: MultiAgentTool = {
  displayName: "Code Runner",
  name: 'RUN{',
  endToken: '}',

  /**
   * Stages files and executes them. Supports Python (.py) and Rust (.rs).
   */
  async execute(params: Record<string, unknown>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {
    const updateProgress = (message: string) => {
        context.sendMessage(JSON.stringify({
        status: 'PROGRESS_UPDATES',
        completed_status_message: message,
        }));
    };

    const files = params['files'] as string[];

    // 1. Validation
    if (!files || files.length === 0) {
      updateProgress("Error: No files provided to execute.");
      return { result: "Error: No files provided to execute." };
    }

    const mainScript = files[0];
    const otherFiles = files.slice(1);
    const ext = path.extname(mainScript).toLowerCase();
    const isRust = ext === '.rs';
    const isPython = ext === '.py';

    if (!isRust && !isPython) {
        updateProgress(`Error: Unsupported file type '${ext}'`);
        return { result: `Error: Unsupported file type '${ext}'. Please provide .py or .rs files.` };
    }

    // 2. Prepare Temp Directory
    let tempDir = '';
    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'momoa-run-'));
        
        // --- Dependency Setup ---
        const depsPath = path.join(os.tmpdir(), DEPS_DIR_NAME);
        await fs.mkdir(depsPath, { recursive: true });

        // Python Dependencies
        if (isPython && PYTHON_REQUIRED_DEPS.length > 0) {
            try {
                await runScript('python3', ['-m', 'pip', 'install', '--target', depsPath, ...PYTHON_REQUIRED_DEPS], tempDir, process.env, INSTALL_TIMEOUT_MS);
            } catch (e) {
                 updateProgress(`Dependency Installation Failed: ${e}`);
                 return { result: `Dependency Installation Failed: ${e}` };
            }
        }

        // 3. Stage Files
        const stageFile = async (fileName: string) => {
             const content = context.fileMap.get(fileName);
             const targetPath = path.join(tempDir, fileName);
             const targetDir = path.dirname(targetPath);

             await fs.mkdir(targetDir, { recursive: true });

             if (content === undefined) {
                 if (context.binaryFileMap.has(fileName)) {
                     const buf = Buffer.from(context.binaryFileMap.get(fileName)!, 'base64');
                     await fs.writeFile(targetPath, buf);
                     return;
                 }
                 throw new Error(`File '${fileName}' not found in context.`);
             }
             await fs.writeFile(targetPath, content, 'utf8');
        };

        await stageFile(mainScript);
        for (const file of otherFiles) {
            await stageFile(file);
        }

        // 4. Execution Logic
        let cmd = '';
        let args: string[] = [];
        let executionEnv = { ...process.env };
        let compileOutput = '';

        // Calculate 80% of currently free memory in Kilobytes
        const freeMemKB = Math.floor(os.freemem() / 1024);
        const memLimitKB = Math.floor(freeMemKB * MAX_MEM_PERCENTAGE);
        const memLimitMB = Math.floor(memLimitKB / 1024);

        if (isPython) {
            updateProgress(`Executing Python script \`${mainScript}\` (Capped at ${memLimitMB}MB due to underlying hardware contraints)`);
            
            cmd = 'sh';
            // Apply the dynamic memory limit via ulimit before running python
            args = ['-c', `ulimit -v ${memLimitKB} && python3 ${mainScript}`];
            
            executionEnv = {
                ...process.env,
                PYTHONPATH: tempDir + path.delimiter + depsPath + path.delimiter + (process.env.PYTHONPATH || ''),
                PYTHONUNBUFFERED: '1'
            };
        }
        else if (isRust) {
            // Check for Cargo.toml in the staged files
            const hasCargo = files.some(f => f.endsWith('Cargo.toml'));

            if (hasCargo) {
                updateProgress(`Executing Rust Project (Cargo) (Capped at ${memLimitMB}MB)`);
                
                cmd = 'sh';
                args = ['-c', `ulimit -v ${memLimitKB} && cargo run --release --quiet`];
            } else {
                updateProgress(`Compiling and Executing Rust script \`${mainScript}\` (Execution capped at ${memLimitMB}MB due to underlying hardware contraints)`);
                
                const binaryName = 'main_bin';                
                // 1. Compile a memory cap to protect the container from runaway compilation
                const compileRes = await runScript(
                    'sh', 
                    ['-c', `ulimit -v ${memLimitKB} && rustc ${mainScript} -o ${binaryName}`], 
                    tempDir, 
                    process.env, 
                    INSTALL_TIMEOUT_MS
                );

                if (compileRes.exitCode !== 0) {
                    return { result: `Rust Compilation Failed (or ran out of memory):\n${compileRes.stderr}\n${compileRes.stdout}` };
                }
                
                if (compileRes.stderr) compileOutput += `[Compilation Warning]: ${compileRes.stderr}\n`;

                // 2. Execute the resulting binary WITH the same memory cap
                const binaryPath = path.join(tempDir, binaryName);
                cmd = 'sh';
                args = ['-c', `ulimit -v ${memLimitKB} && ${binaryPath}`];
            }
        }

        // Run the command
        const { stdout, stderr, timedOut, exitCode } = await runScript(
            cmd, 
            args, 
            tempDir, 
            executionEnv, 
            EXECUTION_TIMEOUT_MS
        );

        let result = compileOutput;

        if (timedOut) {
            result += `Error: Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000} seconds.\n`;
        } else if (exitCode !== 0) {
            result += `Error: Process exited with code ${exitCode}.\n`;
        } else {
            result += `Execution successful.\n`;
        }

        updateProgress(result);

        // 5. Post-Execution: Scan for Output Files
        const normalizedInputFiles = new Set(files.map(f => path.normalize(f)));
        if (isRust) normalizedInputFiles.add('main_bin'); // Exclude the binary we created

        const getFilesRecursively = async (dir: string): Promise<string[]> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const files = await Promise.all(entries.map(async (entry) => {
                const res = path.join(dir, entry.name);
                return entry.isDirectory() ? getFilesRecursively(res) : res;
            }));
            return Array.prototype.concat(...files);
        };

        const allFilesInTemp = await getFilesRecursively(tempDir);
        const generatedFiles: string[] = [];

        for (const fullPath of allFilesInTemp) {
            let relativePath = path.relative(tempDir, fullPath);

            if (normalizedInputFiles.has(relativePath)) continue;
            
            let baseName = path.basename(relativePath);

            // Intercept and rename RESEARCH_LOG.MD to CODE_RUNNER_LOG.md
            if (baseName.toUpperCase() === logFilename.toUpperCase()) {
                const dirName = path.dirname(relativePath);
                const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
                baseName = `CODE_RUNNER_RESEARCH_LOG_${timestamp}.md`;
                relativePath = dirName === '.' ? baseName : path.join(dirName, baseName);
            }

            // Skip common build artifacts
            if (baseName.startsWith('.') || relativePath.includes('__pycache__') || baseName.endsWith('.pyc')) continue;
            if (baseName === 'target' || relativePath.startsWith('target/')) continue; // Skip Cargo target dir

            const stats = await fs.stat(fullPath);

            if (stats.isFile()) {
                if (stats.size > MAX_CONTEXT_FILE_SIZE_BYTES) {
                     result += `\n[Warning] File '${relativePath}' generated but exceeds size limit.\n`;
                }

                const contentBuffer = await fs.readFile(fullPath);
                const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                const isTooLarge = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);
                
                if (isBinary || isTooLarge) {
                     context.binaryFileMap.set(relativePath, contentBuffer.toString('base64'));
                } else {
                  context.fileMap.set(relativePath, contentBuffer.toString('utf8'));
                  await updateFileEntry(relativePath, context.fileMap, context.multiAgentGeminiClient);
                }
                
                context.editedFilesSet.add(relativePath);
                addDynamicallyRelevantFile(relativePath);
                generatedFiles.push(relativePath);
            }
        }

        if (generatedFiles.length > 0) {
            updateProgress(`The following files were generated: ${generatedFiles.join(', ')}`);
            result += `\nGenerated Files: ${generatedFiles.join(', ')}\n`;
        }

        if (stdout && stdout.trim()) result += `\n--- STDOUT ---\n${stdout.trim()}\n`;
        if (stderr && stderr.trim()) result += `\n--- STDERR ---\n${stderr.trim()}\n`;

        return { result: result };
    } catch (e: any) {
        updateProgress(`System Error: ${e.message}`);
        return { result: `System Error: ${e.message}` };
    } finally {
        // Cleanup temp directory
        if (tempDir) {
            try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
    }
  },

  /**
   * Parses the syntax: RUN{file1.py, file2.py, ...}
   * Expects a comma-separated list of filenames.
   */
  async extractParameters(invocation: string, _context: MultiAgentToolContext): Promise<ToolParsingResult> {
    const trimmed = invocation.trim();
    
    // Remove the footer
    const endToken = this.endToken ?? '}';
    if (!trimmed.endsWith(endToken)) {
      return { success: false, error: `Invalid syntax: Must end with '${endToken}'` };
    }
    
    // Content is everything before the footer
    const content = trimmed.substring(0, trimmed.lastIndexOf(endToken));
    
    // Split by comma or pipe, trim whitespace, and remove empty entries
    const files = content
        .split(/[,|]/)
        .map(f => f.trim())
        .filter(f => f.length > 0);

    if (files.length === 0) {
        return { success: false, error: "No files specified." };
    }

    return {
        success: true,
        params: {
            files: files
        }
    };
  }
};