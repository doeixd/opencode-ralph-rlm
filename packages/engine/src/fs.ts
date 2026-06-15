import { mkdir, readFile, writeFile, appendFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

export class FileError extends Error {
  readonly path: string;

  constructor(message: string, filePath: string) {
    super(message);
    this.name = "FileError";
    this.path = filePath;
  }
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    throw new FileError(String(err), filePath);
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  } catch (err) {
    throw new FileError(String(err), filePath);
  }
}

export async function appendTextFile(filePath: string, content: string): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, content, "utf8");
  } catch (err) {
    throw new FileError(String(err), filePath);
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTextFile(
  filePath: string,
  defaultContent: string
): Promise<void> {
  if (!(await fileExists(filePath))) {
    await writeTextFile(filePath, defaultContent);
  }
}

export async function removeFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore missing files
  }
}