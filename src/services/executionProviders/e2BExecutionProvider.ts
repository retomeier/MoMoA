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

import { Sandbox } from 'e2b';
import * as path from 'path';
import { 
    ExecutionProvider, 
    ExecutionRequest, 
    ExecutionResponse,
    FilePayload,
} from '../executionProvider.js';
import { 
    LARGE_FILE_LIMIT_KB, 
 } from '../../momoa_core/types.js';

export class E2BExecutionProvider implements ExecutionProvider {
    providerName = "E2B Sandboxes";
    isPersistentSandbox = false;

    private templateId: string = 'code-interpreter-v1';
    // Target uptime per VM to optimize E2B billing (e.g., pack enough tasks to hit 5 mins)
    private targetVmUptimeMs: number = 1 * 60 * 1000;

    constructor(
        private apiKey: string,
        private persistentSandbox?: Sandbox
    ) { 
        if (persistentSandbox)
            this.isPersistentSandbox = true;
     }

     async cleanupSandbox(): Promise<void> {
       throw new Error("Cloud Run Jobs execution environment is ephemeral. Not cleanup required.");
     }

    private async createSandbox(timeout: number) {
        const sandbox = await Sandbox.create(this.templateId, { 
            apiKey: this.apiKey, 
            timeoutMs: timeout 
        });

        // Dynamically install GNU time for memory profiling
        try {
            console.log(`[E2B Hybrid] Installing GNU 'time' in sandbox ${sandbox.sandboxId}...`);
            await sandbox.commands.run(
                'sudo apt-get update && sudo apt-get install -y time',
                { timeoutMs: 30000 } // 30s timeout so a stalled apt repo doesn't hang your boot process
            );
        } catch (error) {
            console.warn("[E2B Hybrid] Failed to dynamically install 'time'. Memory profiling will fallback to the 500MB default.", error);
        }

        return sandbox;
    }

    async stageFiles(files: FilePayload[], targetDir: string): Promise<void> {
        if (!this.persistentSandbox)
            throw new Error("No Persistent E2B Sandbox available.");

        return await this._stageFiles(this.persistentSandbox, files, targetDir);
    }

    private async _stageFiles(sandbox: Sandbox, files: FilePayload[], targetDir: string): Promise<void> {
        await sandbox.files.makeDir(targetDir);
        
        for (const file of files) {
            const destPath = path.posix.join(targetDir, file.path);
            await sandbox.files.makeDir(path.posix.dirname(destPath));
            
            let dataToWrite: string | ArrayBuffer;
            if (file.isBinary) {
                const nodeBuffer = Buffer.from(file.content, 'base64');
                dataToWrite = nodeBuffer.buffer.slice(
                    nodeBuffer.byteOffset, 
                    nodeBuffer.byteOffset + nodeBuffer.byteLength
                );
            } else {
                dataToWrite = Buffer.from(file.content, 'base64').toString('utf8');
            }
            await sandbox.files.write(destPath, dataToWrite);
        }
    }

    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        // Fallback to a single empty environment if envs is not provided
        const envsToRun = request.envs && request.envs.length > 0 ? request.envs : [{}];
        const totalTasks = envsToRun.length;

        if (!this.apiKey){
            console.log("Missing E2B API Key");
            throw new Error("Missing E2B API Key.");

        }

        if (totalTasks === 0) {
            console.log("No tasks provided for execution.");
            throw new Error("No tasks provided for execution.");
        }

        if (this.persistentSandbox) {
            console.log(`[E2B Hybrid] Running in persistent sandbox ${this.persistentSandbox.sandboxId}`);
            
            // Allow the request to specify a target directory, defaulting to standard task isolation
            const workDir = request.cwd || `/home/user/task_persistent`;
            
            if (request.files && request.files.length > 0) {
                await this._stageFiles(this.persistentSandbox, request.files, workDir);
            }

            // Run the single task (assuming Orchestrator uses 1 env for the agent)
            const response = await this.runSingleTaskInSandbox(
                this.persistentSandbox, 
                request, 
                envsToRun[0], 
                workDir
            );

            return response;
        }

        // 1. Boot the initial VM (used as either the sole runner or the hardware probe)
        // (Assuming you have a helper to create the sandbox)
        const firstSandbox = await this.createSandbox(request.timeoutMs ?? 600000); 

        // =========================================================
        // PATH A: SINGLE TASK (e.g., Dry Run)
        // =========================================================
        if (totalTasks === 1) {
            try {
                const baseWorkDir = `/home/user/base_single`;

                await this._stageFiles(firstSandbox, request.files || [], baseWorkDir)
                await firstSandbox.files.makeDir(baseWorkDir);

                // Isolate the task directory as you do in the chunk worker
                const taskWorkDir = `/home/user/task_single`;
                await firstSandbox.commands.run(`cp -r ${baseWorkDir}/. ${taskWorkDir}`);

                // Execute using your actual method signature
                const singleResponse = await this.runSingleTaskInSandbox(firstSandbox, request, envsToRun[0], taskWorkDir);

                (singleResponse as any).config = envsToRun[0];
                
                if (request.onTaskComplete) request.onTaskComplete(singleResponse);
                
                return singleResponse;

            } finally {
                await firstSandbox.kill();
            }
        }

        // =========================================================
        // PATH B: MULTIPLE TASKS (Batch Execution)
        // =========================================================
        let maxCpuConcurrency = 2; 
        let vmTotalAvailableMemoryMb = 500; 

        try {
            // Dynamically query hardware limits from the Linux kernel using the firstSandbox
            const probeCmd = await firstSandbox.commands.run(
                `echo "$(nproc) | $(awk '/MemTotal/ {print $2}' /proc/meminfo)"`
            );
            
            if (probeCmd.exitCode === 0 && probeCmd.stdout) {
                const [cpuStr, memKbStr] = probeCmd.stdout.trim().split(' | ');
                maxCpuConcurrency = parseInt(cpuStr, 10) || maxCpuConcurrency;
                
                const totalKb = parseInt(memKbStr, 10);
                if (totalKb) {
                    vmTotalAvailableMemoryMb = Math.max(500, Math.floor(totalKb / 1024) - 500); 
                }
            }
        } catch (err) {
            console.warn("[E2B Hybrid] Failed to probe VM hardware, using safe defaults.", err);
        }

        // --- 2. DYNAMIC CONCURRENCY CALCULATION ---
        const estimatedTaskDurationMs = request.estimatedTaskDurationMs || 60000;
        
        // Default to a safe fallback (e.g., 500MB) if the Dry Run didn't provide a memory estimate
        const taskMemoryMb = request.estimatedTaskPeakMemory || 500; 

        // Calculate bottlenecks
        const maxMemoryConcurrency = Math.max(1, Math.floor(vmTotalAvailableMemoryMb / taskMemoryMb));
        const internalConcurrency = Math.min(maxCpuConcurrency, maxMemoryConcurrency);

        console.log(`[E2B Hybrid] Hardware detected: ${maxCpuConcurrency} vCPUs, ${vmTotalAvailableMemoryMb}MB usable RAM.`);
        console.log(`[E2B Hybrid] Task demands ~${taskMemoryMb}MB. Dynamic concurrency set to: ${internalConcurrency}`);

        // --- 3. HORIZONTAL CHUNKING ---
        // Determine how many tasks one VM should process sequentially to reach the target uptime
        const tasksPerVm = Math.max(
            1, 
            Math.ceil((this.targetVmUptimeMs / estimatedTaskDurationMs) * internalConcurrency)
        );

        // Split tasks into chunks. Each chunk gets its own dedicated VM.
        const vmChunks: NodeJS.ProcessEnv[][] = [];
        for (let i = 0; i < totalTasks; i += tasksPerVm) {
            vmChunks.push(envsToRun.slice(i, i + tasksPerVm));
        }

        console.log(`[E2B Hybrid] Total Tasks: ${totalTasks}. Spawning ${vmChunks.length} VMs. (Max ${tasksPerVm} tasks/VM)`);

        let allSucceeded = true;
        let processedCount = 0;
        let lastError = '';

        // --- 4. REUSABLE TASK PROCESSOR ---
        // We wrap the VM task logic in a helper so we can use it for the probe VM and new VMs
        const processChunk = async (sandbox: Sandbox, chunkEnvs: NodeJS.ProcessEnv[], chunkIndex: number) => {
            const baseWorkDir = `/home/user/base_${chunkIndex}`;

            try {
                // Stage files
                await this._stageFiles(sandbox, request.files || [], baseWorkDir);

                let currentIndex = 0;

                // --- 4. INTERNAL WORKER POOL (Vertical Scaling) ---
                const worker = async () => {
                    while (currentIndex < chunkEnvs.length) {
                        const taskIndex = currentIndex++;
                        const env = chunkEnvs[taskIndex];
                        const taskWorkDir = `/home/user/task_${chunkIndex}_${taskIndex}`;

                        // Isolate this task's filesystem by copying the base files locally within the VM
                        await sandbox.commands.run(`cp -r ${baseWorkDir}/. ${taskWorkDir}`);

                        const taskResponse = await this.runSingleTaskInSandbox(sandbox, request, env, taskWorkDir);
                        
                        if (taskResponse.exitCode !== 0) {
                            allSucceeded = false;
                            if (taskResponse.error || taskResponse.stderr) lastError = taskResponse.error || taskResponse.stderr;
                        }

                        (taskResponse as any).config = env;
                        if (request.onTaskComplete) request.onTaskComplete(taskResponse);

                        processedCount++;
                    }
                };

                // Spin up exactly enough internal workers based on our calculated bottleneck
                const activeWorkers = Math.min(internalConcurrency, chunkEnvs.length);
                const workers = Array.from({ length: activeWorkers }, () => worker());
                
                // Wait for this VM's task chunk to finish completely
                await Promise.all(workers);

            } finally {
                // Wipe the VM when the chunk is done, cleaning up all files and processes automatically
                await sandbox.kill();
            }
        };

        // --- 5. EXECUTE ALL CHUNKS ---
        const chunkPromises: Promise<void>[] = [];

        if (vmChunks.length > 0) {
            // Hand chunk 0 to the VM we already booted for the hardware probe
            chunkPromises.push(processChunk(firstSandbox, vmChunks[0], 0));
        } else {
            // Failsafe in case of 0 tasks
            await firstSandbox.kill(); 
        }

        // Spin up parallel VMs for any remaining chunks
        for (let i = 1; i < vmChunks.length; i++) {
            chunkPromises.push((async () => {
                const sb = await this.createSandbox(request.timeoutMs ?? 600000);
                await processChunk(sb, vmChunks[i], i);
            })());
        }

        await Promise.all(chunkPromises);

        return {
            stdout: `Successfully processed ${processedCount} tasks across ${vmChunks.length} VMs.`,
            stderr: allSucceeded ? '' : `One or more tasks failed. Last error: ${lastError}`,
            exitCode: allSucceeded ? 0 : 1,
            timedOut: false,
            generatedFiles: []
        };
    }

    private async runSingleTaskInSandbox(
        sandbox: Sandbox, 
        request: ExecutionRequest, 
        env: NodeJS.ProcessEnv, 
        cwd: string
    ): Promise<ExecutionResponse> {
        const response: ExecutionResponse = {
            stdout: '', stderr: '', exitCode: null, timedOut: false, generatedFiles: []
        };

        const sweepScript = `
#!/bin/bash
FILES_JSON="["
FIRST=1

# Find all files, excluding hidden and cache files
while IFS= read -r -d '' file; do
    REL_PATH="\${file#./}"
    
    # Python check for binary and size
    IS_BINARY=$(python3 -c "
import sys, os
file_path = sys.argv[1]
limit_kb = float(sys.argv[2])
try:
    size_kb = os.path.getsize(file_path) / 1024.0
    is_bin = size_kb > limit_kb
    if not is_bin:
        with open(file_path, 'rb') as f:
            is_bin = b'\\x00' in f.read(1024)
    print('true' if is_bin else 'false')
except Exception:
    print('true')
" "$file" "${LARGE_FILE_LIMIT_KB}")

    # Base64 encode and strip newlines so it fits in JSON
    B64_CONTENT=$(base64 -w 0 "$file" | tr -d '\\n')

    if [ $FIRST -eq 0 ]; then
        FILES_JSON="$FILES_JSON,"
    fi
    FIRST=0

    FILES_JSON="$FILES_JSON{\\"path\\": \\"$REL_PATH\\", \\"isBinary\\": $IS_BINARY, \\"content\\": \\"$B64_CONTENT\\"}"

done < <(find . -type f -not -path '*/\\.*' -not -path '*/__pycache__/*' -not -name 'target' -not -path '*/target/*' -not -name 'main_bin' -not -name '__momoa_wrapper.py' -print0)

FILES_JSON="$FILES_JSON]"
echo "$FILES_JSON"
`;

        try {
            // E2B expects environment variables to be explicitly typed as strings
            const safeEnvs: Record<string, string> = {};
            for (const [k, v] of Object.entries(env)) {
                if (v !== undefined) safeEnvs[k] = String(v);
            }

            // Construct the raw command string
            let rawCmdString = request.command;
            if (request.args)
                rawCmdString = request.command === 'sh' && request.args[0] === '-c' 
                    ? request.args[1] 
                    : `${request.command} ${request.args.join(' ')}`;
            
            // Write the raw command to an isolated script to completely avoid bash escaping issues
            const taskScriptPath = `${cwd}/.task.sh`;
            await sandbox.files.write(taskScriptPath, rawCmdString);

            // // Check for the GNU time binary. If missing, just run the script directly.
            const cmdString = `if [ -x "/usr/bin/time" ]; then /usr/bin/time -v bash ${taskScriptPath}; else bash ${taskScriptPath}; fi`;

            const startTime = Date.now();

            const process = await sandbox.commands.run(cmdString, {
                cwd: cwd,
                envs: { 
                    ...safeEnvs, 
                    PYTHONPATH: `${cwd}:${safeEnvs.PYTHONPATH || ''}` // Ensure Python sees the task dir
                },
                timeoutMs: request.timeoutMs
            });

            response.durationMs = Date.now() - startTime;
            response.stdout = process.stdout;
            response.exitCode = process.exitCode;

            let cleanStderr = process.stderr;
            const memoryMatch = cleanStderr.match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
            
            if (memoryMatch && memoryMatch[1]) {
                const peakMemoryKb = parseInt(memoryMatch[1], 10);
                // Add a 20% safety buffer for variance between tasks
                response.peakMemory = Math.ceil((peakMemoryKb / 1024) * 1.2); 
                
                // Only strip the /usr/bin/time output if we actually found memory metrics
                cleanStderr = cleanStderr.replace(/Command being timed:[\s\S]*?(?=Exit status|$)/i, '').trim();
            }
            
            response.stderr = cleanStderr;

            // Write the script to a temporary file in the VM to avoid bash quote-escaping nightmares
            const scriptPath = `${cwd}/.sweep.sh`;
            await sandbox.files.write(scriptPath, sweepScript);
            
            // Execute the script
            const sweepProcess = await sandbox.commands.run(`bash ${scriptPath}`, { cwd });
            
            if (sweepProcess.exitCode === 0 && sweepProcess.stdout) {
                try {
                    const generatedFiles = JSON.parse(sweepProcess.stdout.trim());
                    const originalFilesMap = request.files ? new Map(request.files.map(f => [f.path, f.content])) : new Map();

                    for (const file of generatedFiles) {
                        const originalContent = originalFilesMap.get(file.path);
                        
                        // Only add if it's new or modified
                        if (originalContent === undefined || originalContent !== file.content) {
                            response.generatedFiles.push({
                                path: file.path,
                                content: file.content,
                                isBinary: file.isBinary
                            });
                        }
                    }
                } catch (parseError) {
                    console.error("[E2B Hybrid] Failed to parse sweep JSON:", parseError);
                    console.error("Raw output was:", sweepProcess.stdout);
                }
            }

        } catch (err: any) {
            response.error = err.message;
            response.exitCode = 1;
            
            // Catch SDK Timeout Exceptions
            if (err.name === 'TimeoutError' || err.message?.toLowerCase().includes('timeout')) {
                response.timedOut = true;
                response.stderr = `Execution timed out after ${request.timeoutMs}ms`;
            }
        }

        return response;
    }
}