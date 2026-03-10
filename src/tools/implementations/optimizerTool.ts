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
import { MAX_MEM_PERCENTAGE, MAX_SCRIPT_EXECUTION_TIMEOUT } from '../../config/config.js';

const MAX_TOTAL_RUNS = 200;
const TIMEOUT = MAX_SCRIPT_EXECUTION_TIMEOUT;
const LARGE_FILE_LIMIT_KB = 100;

// Helper: Calculate Mean and Standard Deviation
const calculateStats = (values: number[]) => {
    if (values.length === 0) return { mean: 0, std: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    return { mean, std: Math.sqrt(variance) };
};

// Helper: Run script using spawn to avoid maxBuffer issues and provide better streaming control
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
        
        // Cap collection to ~50MB to prevent memory exhaustion, but far higher than exec's 1MB
        const MAX_LOG_SIZE = LARGE_FILE_LIMIT_KB * 2 * 1024; 

        const appendLog = (currentLog: string, newData: string) => {
            const combined = currentLog + newData;
            if (combined.length > MAX_LOG_SIZE) {
                // Keep the last MAX_BYTES chars
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
            child.kill('SIGTERM');
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

export const OptimizerTool: MultiAgentTool = {
  displayName: "Optimizer Tool",
  name: 'OPTIMIZE{',
  endToken: '}OPTIMIZE',

  /**
   * Executes a Grid Search optimization by running the driver script.
   * with various environment variable combinations
   */
  async execute(params: Record<string, unknown>, context: MultiAgentToolContext): Promise<MultiAgentToolResult> {

    const updateProgress = (message: string) => {
        context.sendMessage(JSON.stringify({
        status: 'PROGRESS_UPDATES',
        completed_status_message: message,
        }));
    };

    // 1. Parsing & Inputs
    let evalScript = params['evaluator_script'] as string;
    let searchSpace = params['search_space'] as Record<string, any>;
    const goal = (params['goal'] as string || 'min').toLowerCase();
    const budget = Number(params['budget']) || 0;
    const trials = Number(params['trials']) || 1;

    const isRust = evalScript.endsWith('.rs');
    const isPython = evalScript.endsWith('.py');

    updateProgress(`Conducting Optimization (${isRust ? 'Rust' : 'Python'}):\n* Evaluator: \`${evalScript}\`\n* Goal: ${goal}\n* Budget: ${budget}\n* Trials: ${trials}`);

    // Support "module:function" syntax for Evaluator (Driver)
    let entryPointFunction = null;
    if (evalScript.includes(':')) {
        if (isRust) {
             return { result: "Error: Syntax `script:function` is only supported for Python. For Rust, the binary must run directly." };
        }
        const parts = evalScript.split(':');
        evalScript = parts[0];       
        entryPointFunction = parts[1]; 
    }

    // Dependencies Logic
    let dependencies: string[] = [];
    const rawDependencies = params['dependencies'];
    if (typeof rawDependencies === 'string') {
        try {
            const parsed = JSON.parse(rawDependencies);
            dependencies = Array.isArray(parsed) ? parsed : [rawDependencies];
        } catch (e) { if (rawDependencies.trim() !== '[]') dependencies = [rawDependencies]; }
    } else if (Array.isArray(rawDependencies)) {
        dependencies = rawDependencies;
    }

    // --- Search Space Parsing ---
    if (typeof searchSpace === 'string') {
        try { searchSpace = JSON.parse(searchSpace); } 
        catch (e) { 
            const result = `Error: 'search_space' is invalid JSON.`;
            updateProgress(result);
            return { result: result }; 
        }
    }

    if (!evalScript || !searchSpace || Object.keys(searchSpace).length === 0) {
      const result = `Error: Missing required parameters (Driver Script or Search Space).`;
      updateProgress(result);
      return { result: result };
    }

    updateProgress(`* Search Space: ${JSON.stringify(searchSpace)}\n`);

    // 2. Generate Jobs
    let jobs: Record<string, string>[] = [];

    // STRATEGY A: RANDOM SEARCH (if budget > 0)
    if (budget > 0) {
        // Random Search
        updateProgress('Conducting Random Search.');
        for (let i = 0; i < budget; i++) {
            const job: Record<string, string> = {};
            for (const [key, value] of Object.entries(searchSpace)) {
                // Handle Range Objects: {"min": 0, "max": 10}
                if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'min' in value) {
                    const min = Number(value.min);
                    const max = Number(value.max);
                    const isInt = value.type === 'int';
                    let val = Math.random() * (max - min) + min;
                    if (isInt) val = Math.round(val);
                    job[key] = isInt ? String(val) : val.toFixed(4);
                } else if (Array.isArray(value)) {
                    job[key] = String(value[Math.floor(Math.random() * value.length)]);
                } else {
                    job[key] = String(value);
                }
            }
            jobs.push(job);
        }
    } else {
        // Grid Search
        updateProgress('Conducting Grid Search.');
        jobs = [{}];
        for (const key of Object.keys(searchSpace)) {
            const rawValues = Array.isArray(searchSpace[key]) ? searchSpace[key] : [searchSpace[key]];
            const values = rawValues.map((v: any) => String(v));
            const newJobs: Record<string, string>[] = [];
            for (const base of jobs) {
                for (const val of values) {
                    newJobs.push({ ...base, [key]: val });
                }
            }
            jobs = newJobs;
        }
    }

    // Safety Check
    const totalExecutions = jobs.length * trials;
    if (totalExecutions > MAX_TOTAL_RUNS) {
        const result = `Error: Too many runs requested (${totalExecutions}). Limit is ${MAX_TOTAL_RUNS}. Reduce budget or trials.`;
        updateProgress(result);
        return { result: result };
    }

    // 3. File Staging
    const filesToStage = [{name:'Evaluator', path:evalScript}, ...dependencies.map(d=>({name:'Dep', path:d}))];
    const allFilesMap = new Map<string, string>([...context.fileMap, ...Array.from(context.binaryFileMap.keys()).map(k=>[k,''] as [string,string])]);
    
    // Change type definition if necessary, or simply treat as any for the loop
    const fileContents: Record<string, string | Buffer> = {};
    
    for (const file of filesToStage) {
        if (!allFilesMap.has(file.path)) return { result: `File '${file.path}' not found.` };
        
        if (context.fileMap.has(file.path)) {
            fileContents[file.path] = context.fileMap.get(file.path) || "";
        } else if (context.binaryFileMap.has(file.path)) {
            fileContents[file.path] = Buffer.from(context.binaryFileMap.get(file.path) || "", 'base64');
        } else {
             fileContents[file.path] = "";
        }
    }

    let tempDir = '';
    const resultsLog: string[] = [];
    let bestScore = goal === 'max' ? -Infinity : Infinity;
    let bestParams: Record<string, string> = {};
    let bestStats = { mean: 0, std: 0 };
    // Track the directory of the best run to retrieve files later
    let bestRunDir: string | null = null;
    let runCounter = 0;

    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'momoa-opt-'));
        for (const file of filesToStage) {
            // Use the full relative path to preserve directory structure
            const destPath = path.join(tempDir, file.path);
            // Ensure the directory exists before writing
            await fs.mkdir(path.dirname(destPath), { recursive: true });
           
            const content = fileContents[file.path];            
            // If content is a Buffer, fs.writeFile handles it correctly without encoding param
            // If it's a string, we can default to utf8
            if (Buffer.isBuffer(content)) {
                await fs.writeFile(destPath, content);
            } else {
                await fs.writeFile(destPath, content, 'utf8');
            }
        }

        // --- PREPARATION: Compile or Wrap ---
        let executableScript = path.basename(evalScript);
        const hasCargo = filesToStage.some(f => f.path.endsWith('Cargo.toml'));
        
        if (isRust) {
            updateProgress("Compiling Rust Driver...");
            if (hasCargo) {
                 // Build release mode
                 const res = await runScript('cargo', ['build', '--release', '--quiet'], tempDir, process.env, TIMEOUT);
                 if (res.exitCode !== 0) return { result: `Cargo Build Failed:\n${res.stderr}` };
                 // Locate binary (heuristics: name of folder or name in toml, but 'cargo run' handles this)
                 // Optimally we just use 'cargo run' every time, but that's slow.
                 // Better: find the binary. For now, we will assume standard 'target/release/<dir_name>' structure is too complex to guess perfectly 
                 // without parsing toml. So we will rely on `cargo run` but skip build if possible, 
                 // or just accept the overhead. 
                 // *Optimization*: Let's stick to `cargo run` for simplicity with Cargo, 
                 // but for single files we MUST compile.
            } else {
                // Single File Compilation
                const compilerLimitKB = Math.floor((os.freemem() / 1024) * MAX_MEM_PERCENTAGE);
                
                // Single File Compilation
                executableScript = 'optimizer_driver';
                const res = await runScript(
                    'sh', 
                    ['-c', `ulimit -v ${compilerLimitKB} && rustc ${evalScript} -o ${executableScript}`], 
                    tempDir, 
                    process.env, 
                    TIMEOUT
                );
                if (res.exitCode !== 0) return { result: `Rust Compilation Failed:\n${res.stderr}` };
            }
        } 
        else if (isPython && entryPointFunction) {
            const moduleName = path.basename(evalScript, '.py');
            const wrapperContent = `
import sys
import ${moduleName}

try:
    # Call the function dynamically
    result = ${moduleName}.${entryPointFunction}()
    print(f"[OPTIMIZER_METRIC]: {result}")
except Exception as e:
    print(f"Wrapper Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
            executableScript = `__momoa_wrapper_${moduleName}.py`;
            await fs.writeFile(path.join(tempDir, executableScript), wrapperContent, 'utf8');
        }

        // --- 4. Dry Run (Validation) ---
        // Run once with the first job's config to ensure the script isn't broken
        updateProgress("Initiating dry run.");
        if (jobs.length > 0) {
            try {
                const dryRunEnv = {
                    ...process.env,
                    ...jobs[0],
                    PYTHONPATH: tempDir + path.delimiter + (process.env.PYTHONPATH || ''),
                };
                
                let cmd = '', args: string[] = [];
                if (isRust) {
                    if (hasCargo) { cmd = 'cargo'; args = ['run', '--release', '--quiet']; }
                    else { cmd = path.join(tempDir, executableScript); args = []; }
                } else {
                    cmd = 'python3'; args = [executableScript];
                }

                const { stdout, stderr, timedOut, exitCode } = await runScript(cmd, args, tempDir, dryRunEnv, TIMEOUT);

                if (timedOut) {
                    const result = `Dry Run Timed Out (Limit: ${TIMEOUT}ms).`;
                    updateProgress(result);
                    return { result: result };
                }
                
                if (exitCode !== 0 && !stdout.includes('[OPTIMIZER_METRIC]')) {
                    const result = `Dry Run Crashed (Exit Code: ${exitCode}):\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`;
                    updateProgress(result);
                    return { result: result };
                }
                
                if (!stdout.includes('[OPTIMIZER_METRIC]')) {
                    let errMsg = `Dry Run Failed: Output missing [OPTIMIZER_METRIC] tag.`;
                    if (stderr) errMsg += `\nSTDERR:\n${stderr}`;
                    else if (stdout) errMsg += `\nSTDOUT:\n${stdout}`;
                    return { result: errMsg };
                }
            } catch (e: any) {
                const result = `Dry Run Error: ${e.message}`;
                updateProgress(result);
                return { result: result };
            }
        }

        // --- 5. Main Execution Loop ---
        updateProgress(`Commencing ${trials} optimization trials:\n\n----`);

        // Define the ceiling for parallel execution
        const MAX_CONCURRENCY = 5;
        
        // Figure out exactly how many workers will run at the same time
        const actualConcurrency = Math.min(jobs.length, MAX_CONCURRENCY);
        
        const freeMemKB = Math.floor(os.freemem() / 1024);
        const memLimitKB = Math.floor((freeMemKB * MAX_MEM_PERCENTAGE) / Math.max(1, actualConcurrency));

        const runJob = async (envConfig: Record<string, string>) => {
            const configStr = JSON.stringify(envConfig);
            const trialScores: number[] = [];
            let lastErrorOutput = "";
            let lastOutput = "";
            let currentRunDir = "";

            for (let t = 0; t < trials; t++) {
                try {
                    const uniqueRunId = runCounter++; 
                    const trialDir = path.join(tempDir, `run_${uniqueRunId}`);
                    await fs.mkdir(trialDir);
                    currentRunDir = trialDir;

                    // Symlink files
                    for (const file of filesToStage) {
                        const sourcePath = path.join(tempDir, file.path);
                        const destPath = path.join(trialDir, file.path);
                        await fs.mkdir(path.dirname(destPath), { recursive: true });
                        await fs.symlink(sourcePath, destPath);
                    }
                    
                    // Specific logic for binaries
                    let cmd = '', args: string[] = [];
                    if (isRust) {
                        if (hasCargo) {
                             // Symlink target dir to avoid recompiling
                             try { await fs.symlink(path.join(tempDir, 'target'), path.join(trialDir, 'target')); } catch(e){}
                             cmd = 'sh'; 
                             args = ['-c', `ulimit -v ${memLimitKB} && cargo run --release --quiet`];
                        } else {
                             // Symlink binary
                             const binSource = path.join(tempDir, executableScript);
                             const binDest = path.join(trialDir, executableScript);
                             await fs.symlink(binSource, binDest);
                             cmd = 'sh'; 
                             args = ['-c', `ulimit -v ${memLimitKB} && ${binDest}`];
                        }
                    } else {
                        // Python Wrapper Symlink
                        if (executableScript !== path.basename(evalScript)) {
                         await fs.symlink(
                            path.join(tempDir, executableScript), 
                            path.join(trialDir, executableScript)
                        );
                        }
                        cmd = 'sh'; 
                        args = ['-c', `ulimit -v ${memLimitKB} && python3 ${executableScript}`];
                    }

                    const currentEnv = {
                        ...process.env,
                        ...envConfig,
                        PYTHONPATH: tempDir + path.delimiter + (process.env.PYTHONPATH || ''),
                        RANDOM_SEED: String(Math.floor(Math.random() * 100000) + t)
                    };

                    const { stdout, timedOut } = await runScript(cmd, args, trialDir, currentEnv, TIMEOUT);

                    lastOutput = stdout;
                    
                    if (timedOut) {
                        lastErrorOutput = `Execution Timed Out (Limit: ${TIMEOUT}ms)`;
                        continue;
                    }

                    const match = stdout.match(/\[OPTIMIZER_METRIC\]:\s*([-\d\.eE]+)/);
                    if (match && !isNaN(parseFloat(match[1]))) {
                        trialScores.push(parseFloat(match[1]));
                    }
                } catch (e: any) { 
                    lastErrorOutput = `Tool Execution Error: ${e.message}`;
                }
            }

            if (trialScores.length === 0) {
                const results = `Params: ${configStr} -> Failed. Details: ${lastErrorOutput.replace(/\n/g, ' ')}`;
                updateProgress(results)
                resultsLog.push(results);
                return;
            }

            const stats = calculateStats(trialScores);
            const displayScore = stats.mean;

            // Log format
            const logSuffix = trials > 1 ? ` (µ=${stats.mean.toFixed(4)}, σ=${stats.std.toFixed(4)})` : ``;
            updateProgress(`Params: ${configStr} -> ${displayScore.toFixed(4)}${logSuffix}`);
            resultsLog.push(`Params: ${configStr} -> ${displayScore.toFixed(4)}${logSuffix}\nOutput:\n${lastOutput.substring(0, 500)}...\n---`);

            const isBetter = goal === 'max' ? (displayScore > bestScore) : (displayScore < bestScore);
            const isStable = Math.abs(displayScore - bestScore) < 0.0001 && stats.std < bestStats.std;
            
            if (isBetter || (trials > 1 && isStable)) {
                bestScore = displayScore;
                bestParams = envConfig;
                bestStats = stats;
                bestRunDir = currentRunDir;
            }
        };

        for (let i = 0; i < jobs.length; i += MAX_CONCURRENCY) {
            await Promise.all(jobs.slice(i, i + MAX_CONCURRENCY).map(runJob));
        }

        updateProgress(`----\n`);

        // --- 6. Sync Generated Files from Best Run ---
        const savedFiles: string[] = [];
        if (bestRunDir) {
            try {
                const filesInTemp = await fs.readdir(bestRunDir);
                for (const fileName of filesInTemp) {
                    if (fileName === '__pycache__' || fileName.endsWith('.pyc')) continue;
                    if (fileName === 'target' || fileName === 'main_bin' || fileName === executableScript) continue; 

                    const filePath = path.join(bestRunDir, fileName);
                    const stats = await fs.stat(filePath);
                    
                    if (stats.isFile()) {
                        const fileBuffer = await fs.readFile(filePath);
                        const isBinary = fileBuffer.subarray(0, 1024).includes(0);
                        
                        // Only save if changed
                        const oldBin = context.binaryFileMap.get(fileName);
                        const oldTxt = context.fileMap.get(fileName);
                        let changed = false;

                        if (isBinary) {
                            const newBase64 = fileBuffer.toString('base64');
                            if (newBase64 !== oldBin) {
                                context.binaryFileMap.set(fileName, newBase64);
                                changed = true;
                            }
                        } else {
                            const newText = fileBuffer.toString('utf8');
                            if (newText !== oldTxt) {
                                context.fileMap.set(fileName, newText);
                                changed = true;
                            }
                        }

                        if (changed) {
                            savedFiles.push(fileName);
                            context.editedFilesSet.add(fileName);
                            addDynamicallyRelevantFile(fileName);
                            if (!isBinary) await updateFileEntry(fileName, context.fileMap, context.multiAgentGeminiClient);
                        }
                    }
                }
            } catch (persistErr) { console.error("Sync error:", persistErr); }
        }

        // --- 7. Report ---
        // Return verbose errors if ALL failed
        if (resultsLog.every(l => l.includes('-> Failed. Details:'))) {
            updateProgress(`Optimization Failed (All runs failed)`);
            return { result: `Optimization Failed (All runs failed).\n\nErrors:\n${resultsLog.join('\n')}` };
        }

        const header = `Optimization Complete (Strategy: ${budget > 0?'Random':'Grid'}, Trials: ${trials})`;
        const bestStr = trials > 1 ? `Best Mean: ${bestStats.mean.toFixed(4)} (StdDev: ${bestStats.std.toFixed(4)})` : `Best Score: ${bestScore}`;
        
        let output = `${header}\nBest Params: ${JSON.stringify(bestParams)}\n${bestStr}`;
        
        updateProgress(output);

        if (savedFiles.length > 0) {
             output += `\n\nFiles generated/updated (from best run): ${savedFiles.join(', ')}`;
        }

        output += `\n\nLog (Top 20):\n${resultsLog.slice(0, 20).join('\n')}`;

        return { result: output };

    } catch (err) { return { result: `Tool Error: ${err}` }; } 
    finally { if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(()=>{}); }
  },

  async extractParameters(invocation: string): Promise<ToolParsingResult> {
    const trimmed = invocation.trim();
    if (!trimmed.endsWith(this.endToken!)) return { success: false, error: `Invalid syntax.` };
    const content = trimmed.substring(0, trimmed.lastIndexOf(this.endToken!));
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    
    if (jsonStart < 0 || jsonEnd < 0) return { success: false, error: `JSON search space missing.` };

    const preJson = content.substring(0, jsonStart).trim();
    let files: string[] = [], deps: string[] = [];
    const bracketStart = preJson.indexOf('[');
    const bracketEnd = preJson.lastIndexOf(']');

    if (bracketStart !== -1 && bracketEnd > bracketStart) {
        // Part 1: Scripts (before brackets)
        const scriptsPart = preJson.substring(0, bracketStart);
        files = scriptsPart.split(/[,|]/).map(s => s.trim()).filter(s => s);
        
        // Part 2: Dependencies (inside brackets)
        const depsContent = preJson.substring(bracketStart + 1, bracketEnd);
        if (depsContent.trim().length > 0) {
            deps = depsContent.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        }
    } else {
        // Fallback: Legacy comma-separated format
        const parts = preJson.split(/[,|]/).map(s => s.trim()).filter(s => s);
        files = parts.slice(0, 1);
        deps = parts.slice(1);
    }

    if (files.length < 1) return { success: false, error: `Missing driver script.` };
    let searchSpace;
    try { searchSpace = JSON.parse(content.substring(jsonStart, jsonEnd+1)); } 
    catch(e) { return { success: false, error: `Invalid JSON.` }; }
    const args = content.substring(jsonEnd+1).split(/[,|]/).map(s=>s.trim()).filter(s=>s);
    
    return {
        success: true,
        params: {
            evaluator_script: files[0],
            dependencies: deps,
            search_space: searchSpace,
            goal: (args[0]||'min').replace(/['"]/g, '').toLowerCase(),
            budget: parseInt(args[1]||'0'),
            trials: parseInt(args[2]||'1')
        }
    };
  }
};