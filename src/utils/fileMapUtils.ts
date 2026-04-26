/**
 * Copyright 2024 Google LLC
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
 * Combines a file map and a binary file map into a single map.
 * Binary files are assigned a placeholder value.
 *
 * @param fileMap The map of text files.
 * @param binaryFileMap The map of binary files.
 * @param binaryPlaceholder The placeholder value to use for binary files.
 * @returns A new map containing all files.
 */
export function getCombinedFileMap(
  fileMap: Map<string, string>,
  binaryFileMap: Map<string, string>,
  binaryPlaceholder: string = ''
): Map<string, string> {
  return new Map<string, string>([
    ...fileMap,
    ...Array.from(binaryFileMap.keys()).map(key => [key, binaryPlaceholder] as [string, string])
  ]);
}

/**
 * Returns an array of all file keys from both the file map and the binary file map.
 *
 * @param fileMap The map of text files.
 * @param binaryFileMap The map of binary files.
 * @returns An array of all filenames.
 */
export function getAllFileKeys(
  fileMap: Map<string, string>,
  binaryFileMap: Map<string, string>
): string[] {
  return [...fileMap.keys(), ...binaryFileMap.keys()];
}
