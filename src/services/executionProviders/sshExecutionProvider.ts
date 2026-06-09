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

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { 
    ExecutionProvider, 
    ExecutionRequest, 
    ExecutionResponse, 
    FilePayload
} from '../executionProvider.js';
import { 
    LARGE_FILE_LIMIT_KB, 
    MAX_CONTEXT_FILE_SIZE_BYTES 
} from '../../momoa_core/types.js';

export class SshExecutionProvider implements ExecutionProvider {
    providerName = "Generic SSH over Tunnel";
    isPersistentSandbox = false;

    constructor(
        private host: string,
        private port: number,
        private username: string,
        private privateKeyPath?: string // Optional: if omitted, SSH will use the host machine's default agent/keys
    ) { }

    private log(message: string) {
        console.log(`[SshProvider] ${new Date().toISOString()} - ${message}`);
    }

    async cleanupSandbox(): Promise<void> {
    }

    /**
     * Helper to consistently build SSH arguments, avoiding strict host checking 
     * since tunnel IP/Host keys frequently rotate.
     */
    private getSshArgs(remoteCmd?: string): string[] {
        const args = [
            '-p', this.port.toString(),
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', // Prevents cluttering local known_hosts
            '-o', 'BatchMode=yes'                 // Fails fast instead of hanging on interactive password prompts
        ];

        // --- CLOUDFLARE INJECTION ---
        // If the host is a Cloudflare Tunnel, we must proxy the TCP connection through cloudflared
        if (this.host.endsWith('.trycloudflare.com') || this.host.endsWith('.cloudflareaccess.com')) {
            this.log(`Detected Cloudflare Tunnel. Injecting ProxyCommand...`);
            args.push('-o', `ProxyCommand=cloudflared access tcp --hostname %h`);
        }

        // Add the private key if provided
        if (this.privateKeyPath) {
            args.push('-i', this.privateKeyPath);
        }

        // Add the connection string (e.g., root@hostname)
        args.push(`${this.username}@${this.host}`);

        // Add the remote command to execute, if any
        if (remoteCmd) {
            args.push(remoteCmd);
        }

        return args;
    }

    async stageFiles(_files: FilePayload[], _targetDir: string): Promise<void> {
        
    }

    async execute(request: ExecutionRequest): Promise<ExecutionResponse> {
        this.log("Starting SSH parallel execution flow...");
        
        const envsToRun = [...(request.envs && request.envs.length > 0 ? request.envs : [{}])];
        const totalTasks = envsToRun.length;
        
        let processedCount = 0;
        let allSucceeded = true;
        let lastError = '';
        const results: ExecutionResponse[] = new Array(totalTasks);
        let currentIndex = 0;

        if (!this.host || !this.port || !this.username) {
            const errorString = `SSH Provider Error. Missing required connection parameters:
Host: ${this.host ? "Provided" : "Missing"}
Port: ${this.port ? "Provided" : "Missing"}
Username: ${this.username ? "Provided" : "Missing"}`;

            this.log(errorString);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: errorString
            } as any;
        }

        const env: any = { ...process.env };

        try {
            // 1. Verify Connection
            this.log(`Testing SSH connection to ${this.username}@${this.host}:${this.port}...`);
            const connectionTest = await this.runCommand('ssh', this.getSshArgs('echo "Connected"'), env);

            if (connectionTest.exitCode !== 0) {
                this.log(`Connection test failed.`);
                this.log(`Stdout: ${connectionTest.stdout}`);
                this.log(`Stderr: ${connectionTest.stderr}`);
                throw new Error(`Could not connect via SSH. Ensure the tunnel is active and the host/port/key are correct.`);
            }
            this.log("Connection verified successfully.");

            // 2. Ensure GNU 'time' is installed for memory profiling
            this.log("Checking if GNU 'time' is installed on remote host...");
            const installTimeCmd = `if [ ! -x "/usr/bin/time" ]; then sudo apt-get update && sudo apt-get install -y time; fi`;
            
            const timeInstallResult = await this.runCommand('ssh', this.getSshArgs(installTimeCmd), env);

            if (timeInstallResult.exitCode !== 0) {
                this.log(`Warning: Failed to install GNU 'time'. Memory profiling will fallback to defaults. Stderr: ${timeInstallResult.stderr}`);
            } else {
                this.log("GNU 'time' is ready.");
            }

            // 3. Hardware Probing
            let maxCpuConcurrency = 2; 
            let vmTotalAvailableMemoryMb = 500; 

            try {
                this.log("Probing remote hardware for dynamic concurrency scaling...");
                const probeResult = await this.runCommand('ssh', this.getSshArgs('echo "$(nproc) | $(awk \'/MemTotal/ {print $2}\' /proc/meminfo)"'), env);

                if (probeResult.exitCode === 0 && probeResult.stdout) {
                    const [cpuStr, memKbStr] = probeResult.stdout.trim().split(' | ');
                    const nproc = parseInt(cpuStr, 10) || 1;    
                    maxCpuConcurrency = nproc * 2;
                    
                    const totalKb = parseInt(memKbStr, 10);
                    if (totalKb) {
                        vmTotalAvailableMemoryMb = Math.max(500, Math.floor(totalKb / 1024) - 500); 
                    }
                }
            } catch (err) {
                this.log(`Failed to probe remote hardware, using safe defaults. Error: ${err}`);
            }

            const taskMemoryMb = request.estimatedTaskPeakMemory || 500; 
            const maxMemoryConcurrency = Math.max(1, Math.floor(vmTotalAvailableMemoryMb / taskMemoryMb));
            const internalConcurrency = Math.min(maxCpuConcurrency, maxMemoryConcurrency);
            const activeWorkers = Math.min(internalConcurrency, totalTasks);

            this.log(`Hardware detected: ${maxCpuConcurrency / 2} vCPUs. Scaling to ${maxCpuConcurrency} task slots.`);
            this.log(`Memory available: ${vmTotalAvailableMemoryMb}MB. RAM limits concurrency to: ${maxMemoryConcurrency}`);
            this.log(`Final worker count: ${activeWorkers}`);

            const worker = async () => {
                while (currentIndex < totalTasks) {
                    const taskIndex = currentIndex++;
                    const taskEnv = envsToRun[taskIndex];

                    try {
                        const taskResponse = await this.runSingleTask(request, taskEnv, env);
                        
                        if (taskResponse.exitCode !== 0) {
                            allSucceeded = false;
                            if (taskResponse.error || taskResponse.stderr) {
                                lastError = taskResponse.error || taskResponse.stderr;
                            }
                        }

                        (taskResponse as any).config = taskEnv;
                        
                        if (request.onTaskComplete) {
                            request.onTaskComplete(taskResponse);
                        }

                        results[taskIndex] = taskResponse;
                    } catch (err: any) {
                        allSucceeded = false;
                        lastError = err.message;
                    }
                    processedCount++;
                }
            };

            this.log(`Starting ${totalTasks} tasks using ${activeWorkers} concurrent workers.`);
            const workers = Array.from({ length: activeWorkers }, () => worker());
            await Promise.all(workers);

            if (totalTasks === 1) return results[0];

            return {
                stdout: `Successfully processed ${processedCount} tasks remotely.`,
                stderr: allSucceeded ? '' : `One or more tasks failed. Last error: ${lastError}`,
                exitCode: allSucceeded ? 0 : 1,
                timedOut: false,
                generatedFiles: [],
            };

        } catch (err: any) {
            this.log(`ERROR: ${err.message}`);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: `SSH Provider Error: ${err.message}`
            } as any;
        }
    }

    private async runSingleTask(request: ExecutionRequest, taskEnv: Record<string, any>, env: any): Promise<any> {
        this.log("Starting single task execution flow...");

        const localStagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-local-run-'));
        const remoteWorkspace = `~/run_${path.basename(localStagingDir)}`;
        const originalFilesMap = new Map<string, string>();

        let downloadDir: string | undefined;

        try {

            this.log(`Staging ${request.files?.length ?? 0} files locally...`);
            if (request.files)
                for (const file of request.files) {
                    const destPath = path.join(localStagingDir, file.path);
                    originalFilesMap.set(path.normalize(file.path), file.content);
                    await fs.mkdir(path.dirname(destPath), { recursive: true });
                    await fs.writeFile(destPath, Buffer.from(file.content, 'base64'));
                }

            this.log(`Creating remote workspace: ${remoteWorkspace}`);
            await this.runCommand('ssh', this.getSshArgs(`mkdir -p ${remoteWorkspace}`), env);
            
            this.log("Uploading files via tar stream...");
            const uploadResult = await this.runPipeCommand(
                'tar', ['-czf', '-', '-C', localStagingDir, '.'],
                'ssh', this.getSshArgs(`tar -xzf - -C ${remoteWorkspace}`),
                env
            );
            
            if (uploadResult.exitCode !== 0) {
                throw new Error(`Upload failed: ${uploadResult.stderr}`);
            }

            const envPrefix = Object.entries(taskEnv)
                .map(([k, v]) => `${k}='${v}'`)
                .join(' ');

            let rawCmdString = request.command;
            if (request.args)
                rawCmdString = request.command === 'sh' && request.args[0] === '-c' 
                    ? request.args[1] 
                    : `${request.command} ${request.args.join(' ')}`;
            
            const scriptContent = Buffer.from(`${envPrefix} ${rawCmdString}`).toString('base64');
            
            const fullRemoteCommand = `cd ${remoteWorkspace} && ` +
                `echo "${scriptContent}" | base64 -d > .task.sh && ` +
                `if [ -x "/usr/bin/time" ]; then /usr/bin/time -v bash .task.sh; else bash .task.sh; fi`;

            this.log(`Executing remote command: ${request.command}`);
            const startTime = Date.now();
            const execResult = await this.runCommand('ssh', this.getSshArgs(fullRemoteCommand), env, request.timeoutMs);
            const durationMs = Date.now() - startTime;
            
            this.log(`Execution finished with exit code: ${execResult.exitCode}`);
            
            let cleanStderr = execResult.stderr;
            let peakMemory: number | undefined;

            const memoryMatch = cleanStderr.match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
            if (memoryMatch && memoryMatch[1]) {
                const peakMemoryKb = parseInt(memoryMatch[1], 10);
                peakMemory = Math.ceil((peakMemoryKb / 1024) * 1.2); 
                
                cleanStderr = cleanStderr.replace(/Command being timed:[\s\S]*?(?=Exit status|$)/i, '').trim();
            }

            const response: ExecutionResponse = {
                stdout: execResult.stdout,
                stderr: cleanStderr,
                exitCode: execResult.exitCode,
                timedOut: execResult.timedOut,
                durationMs: durationMs,
                peakMemory: peakMemory,
                generatedFiles: []
            };

            downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-results-'));
            this.log("Downloading generated files for sweeping...");
            
            await this.runPipeCommand(
                'ssh', this.getSshArgs(`tar -czf - -C ${remoteWorkspace} .`),
                'tar', ['-xzf', '-', '-C', downloadDir],
                env
            );

            const allFiles = await this.getFilesRecursively(downloadDir);
            for (const fullPath of allFiles) {
                const relativePath = path.relative(downloadDir, fullPath);
                const baseName = path.basename(relativePath);

                if (
                    baseName.startsWith('.') || 
                    relativePath.includes('__pycache__') || 
                    baseName === 'target' || 
                    relativePath.startsWith('target/') || 
                    baseName === 'main_bin') continue;

                const stats = await fs.stat(fullPath);
                if (stats.isFile() && stats.size <= MAX_CONTEXT_FILE_SIZE_BYTES) {
                    const contentBuffer = await fs.readFile(fullPath);
                    const isBinary = contentBuffer.subarray(0, 1024).includes(0);
                    const isTooLarge = contentBuffer.length > (LARGE_FILE_LIMIT_KB * 1024);

                    const newContentBase64 = contentBuffer.toString('base64');
                    const originalContent = originalFilesMap.get(path.normalize(relativePath));
                    
                    if (originalContent === undefined || originalContent !== newContentBase64) {
                        response.generatedFiles.push({
                            path: relativePath,
                            content: contentBuffer.toString('base64'),
                            isBinary: isBinary || isTooLarge
                        });
                    }
                }
            }
            this.log(`Sweep complete. Found ${response.generatedFiles.length} new files.`);

            this.log("Cleaning up remote workspace...");
            await this.runCommand('ssh', this.getSshArgs(`rm -rf ${remoteWorkspace}`), env);

            return response;

        } catch (err: any) {
            this.log(`ERROR: ${err.message}`);
            return {
                stdout: '', stderr: '', exitCode: 1, timedOut: false, generatedFiles: [],
                error: `SSH Provider Error: ${err.message}`
            } as any;
        } finally {
            this.log("Cleaning up local temporary directories...");
            const cleanupTasks: Promise<void>[] = [];
            
            if (localStagingDir) {
                cleanupTasks.push(fs.rm(localStagingDir, { recursive: true, force: true }).catch(() => {}));
            }

            if (downloadDir) {
               cleanupTasks.push(fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {}));
            }
            
            await Promise.all(cleanupTasks);
        }
    }

    private runCommand(cmd: string, args: string[], env: any, timeoutMs: number = 120000) {
        return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
            const child = spawn(cmd, args, { env });
            let stdout = '', stderr = '', timedOut = false;
            
            const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024;
            const appendLog = (currentLog: string, newData: string) => {
                const combined = currentLog + newData;
                return combined.length > MAX_LOG_SIZE ? `[---Truncated---]\n${combined.slice(-MAX_LOG_SIZE)}` : combined;
            };

            child.stdout.on('data', (d) => { stdout = appendLog(stdout, d.toString()); });
            child.stderr.on('data', (d) => { stderr = appendLog(stderr, d.toString()); });

            const timer = setTimeout(() => {
                timedOut = true;
                this.log(`Command timed out after ${timeoutMs}ms. Killing process...`);
                child.kill('SIGTERM');
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
    }

    private runPipeCommand(cmd1: string, args1: string[], cmd2: string, args2: string[], env: any, timeoutMs: number = 120000) {
        return new Promise<{stdout: string, stderr: string, timedOut: boolean, exitCode: number | null}>((resolve, reject) => {
            const child1 = spawn(cmd1, args1, { env });
            const child2 = spawn(cmd2, args2, { env });
            
            let stdout = '', stderr = '', timedOut = false;

            const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024;
            const appendLog = (currentLog: string, newData: string) => {
                const combined = currentLog + newData;
                return combined.length > MAX_LOG_SIZE ? `[---Truncated---]\n${combined.slice(-MAX_LOG_SIZE)}` : combined;
            };

            child1.stdout.pipe(child2.stdin);
            
            child2.stdout.on('data', (d) => { stdout = appendLog(stdout, d.toString()); });
            child2.stderr.on('data', (d) => { stderr = appendLog(stderr, d.toString()); });
            child1.stderr.on('data', (d) => { stderr = appendLog(stderr, `[Source] ${d.toString()}`); });

            const timer = setTimeout(() => {
                timedOut = true;
                this.log(`Pipe command timed out after ${timeoutMs}ms. Killing processes...`);
                child1.kill('SIGTERM');
                child2.kill('SIGTERM');
            }, timeoutMs);

            child2.on('close', (code) => {
                clearTimeout(timer);
                resolve({ stdout, stderr, timedOut, exitCode: code });
            });
            child2.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            child1.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
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