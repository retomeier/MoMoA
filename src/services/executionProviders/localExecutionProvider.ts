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
import { ExecutionProvider, ExecutionRequest, ExecutionResponse, FilePayload } from '../executionProvider.js';
import { getAvailableMemoryBytes } from '../../utils/memoryChecker.js';
import { MAX_MEM_PERCENTAGE } from '../../config/config.js';
import { 
    LARGE_FILE_LIMIT_KB, 
    MAX_CONTEXT_FILE_SIZE_BYTES } from '../../momoa_core/types.js';

export class LocalExecutionProvider implements ExecutionProvider {
    
    providerName = "Local Dev Environment";
    isPersistentSandbox = false;

    async stageFiles(_files: FilePayload[], _targetDir: string): Promise<void> {
      throw new Error("Local Execution Provider only stages files within execution.");
    }

    async cleanupSandbox(): Promise<void> {
      throw new Error("Local Execution Provider cleans up temporary files when execution is complete.");
    }

    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        // Fallback to a single empty environment if envs is not provided
        const envsToRun = request.envs && request.envs.length > 0 ? request.envs : [{}];
        const taskCount = envsToRun.length;

        let allSucceeded = true;
        let processedCount = 0;
        let lastError = '';

        const results: ExecutionResponse[] = new Array(taskCount);
        let currentIndex = 0;

        // Automatically scale concurrency to the host machine's logical CPU cores 
        // We ensure a minimum of 1, and optionally cap it (e.g., at 8 or 16) if you want to leave resources for the OS.
        const CONCURRENCY_LIMIT = Math.max(1, os.cpus().length);

        // Worker function that pulls the next available task until the queue is empty
        const worker = async () => {
            while (currentIndex < taskCount) {
                // Grab the next index and immediately increment so other workers don't take it
                const taskIndex = currentIndex++;
                const env = envsToRun[taskIndex];

                const taskResponse = await this.runSingleTask(request, env);
                
                if (taskResponse.exitCode !== 0) {
                    allSucceeded = false;
                    if (taskResponse.error || taskResponse.stderr) {
                        lastError = taskResponse.error || taskResponse.stderr;
                    }
                }
                
                // Attach the config so the Optimizer tool can map results back
                (taskResponse as any).config = env;
                
                // Stream results back as soon as this specific local task finishes
                if (request.onTaskComplete) {
                    request.onTaskComplete(taskResponse);
                }
                
                processedCount++;
                results[taskIndex] = taskResponse;
            }
        };

        // Spin up the worker pool (only create as many workers as we have CPUs or tasks, whichever is smaller)
        const activeWorkers = Math.min(CONCURRENCY_LIMIT, taskCount);
        console.log(`[LocalExecution] Starting ${taskCount} tasks using ${activeWorkers} concurrent workers.`);
        
        const workers = Array.from({ length: activeWorkers }, () => worker());

        // Wait for all workers to finish processing the queue
        await Promise.all(workers);

        // If it's just a single task, return the exact response like before
        if (taskCount === 1) {
            return results[0];
        }

        // Return an aggregate response for batched tasks
        return {
            stdout: `Successfully processed ${processedCount} tasks locally using ${activeWorkers} concurrent workers.`,
            stderr: allSucceeded ? '' : `One or more local tasks failed. Last error: ${lastError}`,
            exitCode: allSucceeded ? 0 : 1,
            timedOut: false,
            generatedFiles: [], // The tool collects files dynamically via onTaskComplete
        };
    }

    private async runSingleTask(request: ExecutionRequest, env: NodeJS.ProcessEnv): Promise<ExecutionResponse> {
        let tempDir = '';
        const response: ExecutionResponse = {
            stdout: '', stderr: '', exitCode: null, timedOut: false, generatedFiles: []
        };

        try {
            // Give every parallel task its own isolated directory
            tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-run-'));
            const normalizedInputFiles = new Set<string>();

            // 1. Stage Files
            if (request.files)
                for (const file of request.files) {
                    const destPath = path.join(tempDir, file.path);
                    normalizedInputFiles.add(path.normalize(file.path));
                    await fs.mkdir(path.dirname(destPath), { recursive: true });
                    
                    if (file.isBinary) {
                        await fs.writeFile(destPath, Buffer.from(file.content, 'base64'));
                    } else {
                        await fs.writeFile(destPath, Buffer.from(file.content, 'base64').toString('utf8'), 'utf8');
                    }
                }

            let args = request.args ? [...request.args] : [];
            
            // 2. Conditionally Apply Memory Limits
            if (os.platform() === 'linux' && request.command === 'sh' && args[0] === '-c') {
                try {
                    const availableMemKB = Math.floor(getAvailableMemoryBytes() / 1024);
                    // Divide memory safely among concurrent workers so they don't collectively OOM
                    const workerMemLimitKB = Math.floor((availableMemKB * MAX_MEM_PERCENTAGE) / os.cpus().length);
                    args[1] = `ulimit -v ${workerMemLimitKB} && ${args[1]}`;
                } catch (memErr) {
                    console.warn("Failed to calculate or apply memory limits:", memErr);
                }
            }

            // 3. Execute with merged environment
            const execResult = await this.runScript(request.command, args, tempDir, { ...process.env, ...env }, request.timeoutMs ?? 600000);
            
            response.stdout = execResult.stdout;
            response.stderr = execResult.stderr;
            response.exitCode = execResult.exitCode;
            response.timedOut = execResult.timedOut;

            // 4. Sweep for generated files
            const allFilesInTemp = await this.getFilesRecursively(tempDir);
            for (const fullPath of allFilesInTemp) {
                const relativePath = path.relative(tempDir, fullPath);
                const baseName = path.basename(relativePath);

                if (normalizedInputFiles.has(relativePath) || baseName.startsWith('.') || relativePath.includes('__pycache__') || baseName === 'target' || relativePath.startsWith('target/') || baseName === 'main_bin') continue;

                const stats = await fs.stat(fullPath);
                if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
                    const contentBuffer = await fs.readFile(fullPath);
                    const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                    const isTooLarge = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);
                    const treatAsBinary = isBinary || isTooLarge;

                    response.generatedFiles.push({
                        path: relativePath,
                        content: treatAsBinary ? contentBuffer.toString('base64') : Buffer.from(contentBuffer.toString('utf8')).toString('base64'),
                        isBinary: treatAsBinary
                    });
                }
            }
        } catch (err: any) {
            response.error = err.message;
        } finally {
            if (tempDir) {
                try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
        return response;
    }

    private runScript(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
        return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
            const child = spawn(cmd, args, { cwd, env });
            let stdout = '', stderr = '', timedOut = false;
            const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024; 
            const appendLog = (currentLog: string, newData: string) => {
                const combined = currentLog + newData;
                return combined.length > MAX_LOG_SIZE ? `[---Output Truncated Due to Length---]\n${combined.slice(-MAX_LOG_SIZE)}` : combined;
            };

            child.stdout.on('data', (data) => { stdout = appendLog(stdout, data.toString()); });
            child.stderr.on('data', (data) => { stderr = appendLog(stderr, data.toString()); });

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                setTimeout(() => { if (!child.killed) try { child.kill('SIGKILL'); } catch (e) {} }, 2000);
            }, timeoutMs);

            child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, timedOut, exitCode: code }); });
            child.on('error', (err) => { clearTimeout(timer); reject(err); });
        });
    }

    private async getFilesRecursively(dir: string): Promise<string[]> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
            const res = path.join(dir, entry.name);
            return entry.isDirectory() ? this.getFilesRecursively(res) : res;
        }));
        return Array.prototype.concat(...files);
    }
}